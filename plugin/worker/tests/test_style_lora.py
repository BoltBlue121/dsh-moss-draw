"""CPU-only tests; run with the existing worker Python, never load full weights."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import torch
from torch import nn

PACKAGE_DIR = Path(__file__).resolve().parents[1] / "moss-draw-style"
PACKAGE = "_moss_draw_style_tests"


def load_package():
    spec = importlib.util.spec_from_file_location(
        PACKAGE, PACKAGE_DIR / "__init__.py", submodule_search_locations=[str(PACKAGE_DIR)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[PACKAGE] = module
    spec.loader.exec_module(module)
    return module


# A missing implementation is intentionally a RED assertion, not a collection error.
class ImplementationExists(unittest.TestCase):
    def test_independent_node_package_exists(self):
        self.assertTrue((PACKAGE_DIR / "__init__.py").is_file(), "style loader not implemented")


class StyleMergeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        load_package()
        cls.api = sys.modules[f"{PACKAGE}.style_lora"]

    def model(self, dtype=torch.float32):
        model = nn.Module()
        layer = nn.Module()
        layer.proj = nn.ModuleDict({name: nn.Linear(2, 2, bias=False, dtype=dtype)
                                    for name in ("q", "k", "v", "o", "ffn_up_gate", "ffn_down")})
        model.layers = nn.ModuleList([layer])
        with torch.no_grad():
            for parameter in model.parameters():
                parameter.copy_(torch.tensor([[1., 2.], [3., 4.]], dtype=dtype))
        return model

    def pair(self, target="proj_q", a=None, b=None, alpha=None, index="0"):
        prefix = f"lora_unet_layers_{index}_{target}"
        result = {f"{prefix}.lora_down.weight": torch.tensor([[1., 2.]]) if a is None else a,
                  f"{prefix}.lora_up.weight": torch.tensor([[3.], [4.]]) if b is None else b}
        if alpha is not None:
            result[f"{prefix}.alpha"] = torch.tensor(alpha)
        return result

    def assert_rejected_without_mutation(self, state, strength=1.0, model=None):
        model = self.model() if model is None else model
        before = {name: value.detach().clone() for name, value in model.state_dict().items()}
        versions = [parameter._version for parameter in model.parameters()]
        with self.assertRaises(ValueError):
            self.api.merge_style_lora(model, state, strength)
        for name, value in model.state_dict().items():
            self.assertTrue(torch.equal(value, before[name]), name)
        self.assertEqual(versions, [parameter._version for parameter in model.parameters()])

    def test_all_plain_projection_names_and_alpha_rank_scaling(self):
        model = self.model()
        state = {}
        for name in ("q", "k", "v", "o", "ffn_up_gate", "ffn_down"):
            state.update(self.pair(f"proj_{name}", alpha=2.))
        self.api.merge_style_lora(model, state, .25)
        # strength .25 * alpha 2 / actual rank 1 => .5 * [[3,6],[4,8]].
        for module in model.layers[0].proj.values():
            torch.testing.assert_close(module.weight, torch.tensor([[2.5, 5.], [5., 8.]]))

    def test_fused_qkv_shares_a_splits_b_rows_and_uses_actual_rank(self):
        model = self.model()
        state = self.pair("proj_qkv", a=torch.tensor([[1., 2.], [3., 4.]]),
                          b=torch.tensor([[1., 0.], [0., 1.], [2., 0.], [0., 2.], [3., 0.], [0., 3.]]),
                          alpha=4.)
        self.api.merge_style_lora(model, state, .5, metadata={"ss_network_dim": "16", "fused_qkv": "1"})
        for name, expected in (("q", [[2., 4.], [6., 8.]]),
                               ("k", [[3., 6.], [9., 12.]]),
                               ("v", [[4., 8.], [12., 16.]])):
            torch.testing.assert_close(model.layers[0].proj[name].weight, torch.tensor(expected))

    def test_alternate_fused_qkv_alias_maps_same_shared_a_and_split_b(self):
        model = self.model()
        state = {key.replace("proj_qkv", "fused_qkv"): value for key, value in
                 self.pair("proj_qkv", b=torch.tensor([[1.], [2.], [3.], [4.], [5.], [6.]])).items()}
        self.api.merge_style_lora(model, state, 1.)
        for name, expected in (("q", [[2., 4.], [5., 8.]]),
                               ("k", [[4., 8.], [7., 12.]]),
                               ("v", [[6., 12.], [9., 16.]])):
            torch.testing.assert_close(model.layers[0].proj[name].weight, torch.tensor(expected))

    def test_alias_fused_encodings_cannot_both_update_same_target(self):
        state = self.pair("proj_qkv", b=torch.ones(6, 1))
        alias = {key.replace("proj_qkv", "fused_qkv"): value for key, value in state.items()}
        self.assert_rejected_without_mutation({**state, **alias})

    def test_missing_alpha_defaults_to_actual_rank(self):
        model = self.model()
        self.api.merge_style_lora(model, self.pair(), -1.)
        torch.testing.assert_close(model.layers[0].proj["q"].weight, torch.tensor([[-2., -4.], [-1., -4.]]))

    def test_fp32_matmul_then_single_cast_preserves_small_delta(self):
        model = self.model(torch.bfloat16)
        with torch.no_grad():
            model.layers[0].proj["q"].weight.fill_(-256.)
        state = self.pair(a=torch.tensor([[1., 1.]]), b=torch.tensor([[256.25], [256.25]]))
        self.api.merge_style_lora(model, state, 1.)
        torch.testing.assert_close(model.layers[0].proj["q"].weight,
                                   torch.full((2, 2), .25, dtype=torch.bfloat16), rtol=0, atol=0)

    def test_strength_zero_is_bitwise_noop_without_version_bump(self):
        model = self.model(torch.bfloat16)
        before = {key: value.clone() for key, value in model.state_dict().items()}
        versions = [value._version for value in model.parameters()]
        self.api.merge_style_lora(model, self.pair(), 0.)
        for key, value in model.state_dict().items():
            self.assertTrue(torch.equal(value, before[key]))
        self.assertEqual(versions, [value._version for value in model.parameters()])

    def test_unknown_dora_missing_and_noncanonical_keys_rejected(self):
        for extra in ("some_unknown", "lora_unet_layers_0_proj_q.dora_scale",
                      "lora_unet_layers_0_proj_q.lora_mid.weight"):
            with self.subTest(extra=extra):
                self.assert_rejected_without_mutation({**self.pair(), extra: torch.ones(1)})
        self.assert_rejected_without_mutation({"lora_unet_layers_0_proj_q.lora_down.weight": torch.ones(1, 2)})
        self.assert_rejected_without_mutation(self.pair(index="00"))
        self.assert_rejected_without_mutation(self.pair(index="5"))
        self.assert_rejected_without_mutation({})

    def test_duplicate_fused_and_plain_target_rejected(self):
        self.assert_rejected_without_mutation({**self.pair(), **self.pair("proj_qkv", b=torch.ones(6, 1))})

    def test_shared_weight_alias_target_rejected(self):
        model = self.model()
        model.layers[0].proj["k"].weight = model.layers[0].proj["q"].weight
        self.assert_rejected_without_mutation({**self.pair(), **self.pair("proj_k")}, model=model)

    def test_shape_and_nonfinite_validate_all_modules_before_any_write(self):
        invalid = [self.pair("proj_k", a=torch.ones(1, 3)),
                   self.pair("proj_k", b=torch.ones(3, 1)),
                   self.pair("proj_k", b=torch.ones(2, 2)),
                   self.pair("proj_qkv", b=torch.ones(5, 1)),
                   self.pair("proj_k", a=torch.tensor([[float("nan"), 1.]])),
                   self.pair("proj_k", b=torch.tensor([[float("inf")], [1.]])),
                   self.pair("proj_k", alpha=float("inf")),
                   self.pair("proj_k", alpha=[1., 2.]),
                   self.pair("proj_k", a=torch.ones(0, 2), b=torch.ones(2, 0)),
                   self.pair("proj_k", a=torch.ones(1, 2, dtype=torch.int64))]
        for bad in invalid:
            with self.subTest(keys=list(bad)):
                self.assert_rejected_without_mutation({**self.pair(), **bad})
        for strength in (float("nan"), float("inf"), True):
            self.assert_rejected_without_mutation(self.pair(), strength)
        self.assert_rejected_without_mutation({**self.pair(), "unknown": torch.ones(1)}, strength=0.)

    def test_fp32_overflow_and_destination_cast_overflow_are_atomic(self):
        self.assert_rejected_without_mutation({**self.pair(), **self.pair("proj_k", a=torch.full((1, 2), 1e30), b=torch.full((2, 1), 1e30))})
        self.assert_rejected_without_mutation({**self.pair(), **self.pair("proj_k", b=torch.full((2, 1), 1e6))}, model=self.model(torch.float16))

    def test_existing_edit_ab_are_not_style_targets(self):
        model = self.model()
        original = model.layers[0].proj["q"]
        wrapper = nn.Module()
        wrapper.base = original
        wrapper.lora_A = nn.Parameter(torch.ones(1, 2))
        wrapper.lora_B = nn.Parameter(torch.ones(2, 1))
        model.layers[0].proj["q"] = wrapper
        self.assert_rejected_without_mutation(self.pair(), model=model)


class LoaderTests(StyleMergeTests):
    """Tiny fake runtime only at the weight-loading/quantization IO boundary."""
    def setUp(self):
        self.nodes = sys.modules[f"{PACKAGE}.nodes"]
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.loras = self.root / "loras"
        self.loras.mkdir()
        self.style = self.loras / "style.safetensors"
        self.style.write_bytes(b"style-one")
        self.events = []
        events = self.events
        model_factory = self.model
        runtime = types.ModuleType("fake_loaded_moss_edit.nodes")
        class Pipeline:
            def __init__(self, snapshot, adapter):
                self.snapshot, self.adapter = snapshot, adapter
                self.options = {"rank": 1, "alpha": 1., "dropout": 0., "targets": ["layers.0.proj.q"], "param_dtype": "float32"}
                self.metadata, self.encoding, self.editor = {}, None, None
            def load_encoders(self):
                return "inherited encoders"
            def offload(self):
                events.append("offload")
        class OriginalLoader:
            pass
        OriginalLoader.__module__ = runtime.__name__
        runtime._MossPipeline = Pipeline
        runtime.MossImageEditLoader = OriginalLoader
        runtime.NODE_CLASS_MAPPINGS = {"MossImageEditLoader": OriginalLoader, "MossImageEdit": object}
        runtime._model_path = lambda value: Path(value).resolve(strict=True)
        def load_transformer(*args, **kwargs):
            events.append("full")
            return model_factory()
        def inject_lora(model, **kwargs):
            events.append("inject")
            # Assert real merged base seen at injection, not style A/B loaded into edit A/B.
            torch.testing.assert_close(model.layers[0].proj["q"].weight, torch.tensor([[4., 8.], [7., 12.]]))
            model.edit_a = nn.Parameter(torch.tensor([71.]))
        def load_adapter(model, adapter):
            events.append("adapter")
            with torch.no_grad():
                model.edit_a.fill_(93.)
        def quantize(model):
            events.append("quantize")
            if model.edit_a.item() != 93.:
                raise AssertionError("quantization ran before edit adapter")
        runtime.load_transformer, runtime.inject_lora, runtime.load_adapter = load_transformer, inject_lora, load_adapter
        runtime.torch_dtype = lambda value: torch.float32
        runtime.MossEditModel = lambda model: model
        runtime.__package__ = "fake_loaded_moss_edit"
        quantization = types.ModuleType("fake_loaded_moss_edit.moss_runtime.quantization")
        quantization.quantize_frozen_linears = quantize
        folders = types.ModuleType("folder_paths")
        folders.get_filename_list = lambda category: ["style.safetensors"]
        folders.get_full_path = lambda category, name: str(self.loras / name)
        folders.get_folder_paths = lambda category: [str(self.loras)]
        self.runtime = runtime
        self.addCleanup(patch.stopall)
        # Only restore our fixture keys. patch.dict(sys.modules) snapshots and
        # clears the ENTIRE import cache on exit; that unloads lazily imported
        # torch.distributed modules while their C++ registrations survive.
        for key, value in {runtime.__name__: runtime, quantization.__name__: quantization, "folder_paths": folders}.items():
            previous = sys.modules.get(key)
            sys.modules[key] = value
            def restore(key=key, previous=previous):
                if previous is None:
                    sys.modules.pop(key, None)
                else:
                    sys.modules[key] = previous
            self.addCleanup(restore)
        patch.object(self.nodes, "read_style_file", return_value=(self.pair(), {})).start()

    def test_loaded_module_discovery_does_not_depend_on_folder_module_name(self):
        self.assertIs(self.nodes.find_edit_runtime(), self.runtime)

    def test_loader_pipeline_order_cache_and_no_accumulation(self):
        loader = self.nodes.MossDrawEditStyleLoader()
        args = (str(self.root), str(self.root), "style.safetensors", 1.)
        pipeline, = loader.load(*args)
        self.assertIsInstance(pipeline, self.runtime._MossPipeline)
        self.assertEqual(pipeline.load_encoders(), "inherited encoders")
        self.assertEqual(self.events, [])
        editor = pipeline.load_editor()
        self.assertEqual(self.events, ["full", "inject", "adapter", "quantize"])
        self.assertEqual(editor.edit_a.item(), 93.)
        self.assertIs(pipeline.load_editor(), editor)
        self.assertIs(loader.load(*args)[0], pipeline)
        self.assertEqual(self.events, ["full", "inject", "adapter", "quantize"])
        changed = loader.load(*args[:-1], .5)[0]
        self.assertIsNot(changed, pipeline)
        self.assertIsNone(changed.editor)
        self.assertIs(loader.load(*args)[0].editor, None)  # Fresh base, never re-merge old instance.
        self.assertNotIn("load_editor", self.runtime._MossPipeline.__dict__)

    def test_same_size_style_replacement_changes_cache_fingerprint(self):
        loader = self.nodes.MossDrawEditStyleLoader()
        args = (str(self.root), str(self.root), "style.safetensors", 1.)
        old_stamp = loader.IS_CHANGED(*args)
        old = loader.load(*args)[0]
        self.style.write_bytes(b"style-two")
        self.assertNotEqual(old_stamp, loader.IS_CHANGED(*args))
        self.assertIsNot(old, loader.load(*args)[0])
        with self.assertRaisesRegex(ValueError, "changed"):
            old.load_editor()
        self.assertEqual(self.events, [])

    def test_style_path_must_be_registered_and_contained(self):
        for name in ("../style.safetensors", str(self.style), r"C:\other.safetensors", "unknown.safetensors"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.nodes.resolve_style_path(name)
        outside = self.root / "outside.safetensors"
        outside.write_bytes(b"no")
        folders = sys.modules["folder_paths"]
        with patch.object(folders, "get_full_path", return_value=str(outside)):
            with self.assertRaises(ValueError):
                self.nodes.resolve_style_path("style.safetensors")

    def test_ambiguous_runtime_refuses_to_guess(self):
        other = types.ModuleType("other_edit.nodes")
        other.__dict__.update(self.runtime.__dict__)
        other.__name__ = "other_edit.nodes"
        class OtherLoader:
            pass
        OtherLoader.__module__ = other.__name__
        other.NODE_CLASS_MAPPINGS = {"MossImageEditLoader": OtherLoader, "MossImageEdit": object}
        sys.modules[other.__name__] = other
        try:
            with self.assertRaisesRegex(RuntimeError, "multiple"):
                self.nodes.find_edit_runtime()
        finally:
            sys.modules.pop(other.__name__, None)


if __name__ == "__main__":
    unittest.main()
