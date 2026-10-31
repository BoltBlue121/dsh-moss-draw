"""Additional loader only; reuse the already-loaded MOSS Image Edit runtime."""
from __future__ import annotations

import hashlib
import importlib
import logging
from pathlib import Path, PureWindowsPath
import sys
import threading
from types import ModuleType

import torch

from .style_lora import finite_strength, merge_style_lora


def find_edit_runtime():
    """Discover by registered class identity, not a custom_nodes folder spelling.

    Deferred until execution so Comfy custom-node import order is irrelevant.
    Do not import another copy of MOSS, register its nodes again, or patch it.
    """
    candidates = {}
    for module in tuple(sys.modules.values()):
        if not isinstance(module, ModuleType):
            continue
        mapping = vars(module).get("NODE_CLASS_MAPPINGS")
        if not isinstance(mapping, dict):
            continue
        cls = mapping.get("MossImageEditLoader")
        if cls is None or "MossImageEdit" not in mapping:
            continue
        runtime = sys.modules.get(getattr(cls, "__module__", ""))
        if isinstance(runtime, ModuleType):
            candidates[id(runtime)] = runtime
    if len(candidates) != 1:
        reason = "multiple loaded runtimes" if candidates else "no loaded runtime"
        raise RuntimeError(
            f"MossDrawEditStyleLoader found {reason}; load exactly one compatible "
            "ComfyUI-Moss-Image-Edit before executing this node."
        )
    runtime = next(iter(candidates.values()))
    required = ("_MossPipeline", "_model_path", "load_transformer", "torch_dtype",
                "inject_lora", "load_adapter", "MossEditModel")
    missing = [name for name in required if not callable(vars(runtime).get(name))]
    pipeline = vars(runtime).get("_MossPipeline")
    if not isinstance(pipeline, type) or any(not callable(getattr(pipeline, name, None))
                                            for name in ("load_encoders", "offload")):
        missing.append("compatible _MossPipeline")
    if missing or not runtime.__package__:
        raise RuntimeError(f"Incompatible loaded MOSS Image Edit runtime; missing {missing!r}.")
    return runtime


def resolve_style_path(style_lora):
    """Accept only registered loras entries, resolving symlinks inside roots."""
    import folder_paths

    if (not isinstance(style_lora, str) or not style_lora or "\0" in style_lora
            or ":" in style_lora or PureWindowsPath(style_lora).is_absolute()
            or Path(style_lora).is_absolute()
            or any(part in ("", ".", "..") for part in style_lora.replace("\\", "/").split("/"))):
        raise ValueError("Style LoRA must be a relative registered Comfy loras entry.")
    if style_lora not in folder_paths.get_filename_list("loras"):
        raise ValueError("Style LoRA is not registered in Comfy loras.")
    resolved = folder_paths.get_full_path("loras", style_lora)
    if resolved is None:
        raise ValueError("Registered style LoRA file is missing.")
    try:
        path = Path(resolved).resolve(strict=True)
    except OSError as error:
        raise ValueError("Style LoRA file is missing or unreadable.") from error
    roots = [Path(root).resolve() for root in folder_paths.get_folder_paths("loras")]
    if not path.is_file() or path.suffix.lower() != ".safetensors" or not any(path.is_relative_to(root) for root in roots):
        raise ValueError("Style LoRA must be a safetensors file within a Comfy loras root.")
    return path


def style_sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_style_file(path, expected_sha256):
    """No pickle; check identity before and after reading a CPU safetensors file."""
    from safetensors import safe_open

    if style_sha256(path) != expected_sha256:
        raise ValueError("Style LoRA file changed since loader configuration; execute loader again.")
    with safe_open(str(path), framework="pt", device="cpu") as handle:
        metadata = handle.metadata() or {}
        state = {key: handle.get_tensor(key) for key in handle.keys()}
    if style_sha256(path) != expected_sha256:
        raise ValueError("Style LoRA file changed while reading; retry after file replacement finishes.")
    return state, metadata


def _pipeline(runtime, snapshot, adapter, style_path, style_hash, strength):
    """Subclass just the editor stage. All encoding/offload/sampling stays upstream."""
    class StylePipeline(runtime._MossPipeline):
        def __init__(self):
            super().__init__(snapshot, adapter)
            self.style_path = style_path
            self.style_sha256 = style_hash
            self.style_strength = strength
            self._editor_lock = threading.Lock()

        @torch.inference_mode(False)
        @torch.no_grad()
        def load_editor(self):
            with self._editor_lock:
                if self.editor is not None:
                    return self.editor
                # Detect replacement before allocating full weights (also when 0).
                if style_sha256(self.style_path) != self.style_sha256:
                    raise ValueError("Style LoRA file changed since loader configuration; execute loader again.")
                state, metadata = read_style_file(self.style_path, self.style_sha256)
                logging.info("MOSS Draw Edit: loading full SFT, merging style before editing adapter and quanto")
                model = runtime.load_transformer(self.snapshot, device="cpu", dtype=torch.bfloat16)
                merge_style_lora(model, state, self.style_strength, metadata=metadata)
                del state
                options = {**self.options, "param_dtype": runtime.torch_dtype(self.options["param_dtype"])}
                # Distinct edit adapter A/B are created AFTER base style merge.
                runtime.inject_lora(model, **options)
                runtime.load_adapter(model, self.adapter)
                model.requires_grad_(False).eval()
                quantization = importlib.import_module(f"{runtime.__package__}.moss_runtime.quantization")
                quantization.quantize_frozen_linears(model)
                editor = runtime.MossEditModel(model).eval()
                self.editor = editor  # No half-loaded editor survives a failure.
                return editor

    return StylePipeline()


class MossDrawEditStyleLoader:
    @classmethod
    def INPUT_TYPES(cls):
        import folder_paths
        return {"required": {
            "snapshot_dir": ("STRING", {"default": "moss_image/MOSS-Image-SFT"}),
            "adapter_dir": ("STRING", {"default": "moss_image/Moss-Image-Edit"}),
            "style_lora": (folder_paths.get_filename_list("loras"),),
            "strength": ("FLOAT", {"default": 1.0, "min": -4.0, "max": 4.0, "step": 0.05}),
        }}

    RETURN_TYPES = ("MOSS_EDIT_MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "load"
    CATEGORY = "MOSS Image Edit"
    DESCRIPTION = (
        "Experimental style-on-Edit loader: merge style into full SFT BEFORE editing adapter/quanto. "
        "Connect to existing MossImageEdit; base-trained styles need visual validation on SFT."
    )

    def __init__(self):
        self._cached_key = None
        self._cached_pipeline = None
        self._cache_lock = threading.Lock()

    @classmethod
    def IS_CHANGED(cls, snapshot_dir, adapter_dir, style_lora, strength):
        strength = finite_strength(strength)
        path = resolve_style_path(style_lora)
        # Hash contents on EVERY query, not just mtime/size: replacement invalidates Comfy's cache.
        return (snapshot_dir, adapter_dir, str(path), style_sha256(path), strength)

    def load(self, snapshot_dir, adapter_dir, style_lora, strength):
        strength = finite_strength(strength)
        runtime = find_edit_runtime()
        snapshot, adapter = runtime._model_path(snapshot_dir), runtime._model_path(adapter_dir)
        if not snapshot.is_dir() or not adapter.is_dir():
            raise ValueError("snapshot_dir and adapter_dir must be directories as in MossImageEditLoader.")
        path = resolve_style_path(style_lora)
        digest = style_sha256(path)
        key = (id(runtime), str(snapshot), str(adapter), str(path), digest, strength)
        with self._cache_lock:
            if key != self._cached_key:
                # Bounded one-entry cache. Changed settings always create a fresh base pipeline;
                # NEVER merge again into the previous instance (even when switching back).
                pipeline = _pipeline(runtime, snapshot, adapter, path, digest, strength)
                self._cached_pipeline = pipeline
                self._cached_key = key
            return (self._cached_pipeline,)


NODE_CLASS_MAPPINGS = {"MossDrawEditStyleLoader": MossDrawEditStyleLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"MossDrawEditStyleLoader": "Load MOSS Edit + Style (experimental)"}
