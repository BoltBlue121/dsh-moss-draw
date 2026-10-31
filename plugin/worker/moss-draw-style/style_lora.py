"""Strict Comfy MOSS style LoRA merge into an unquantized, unadapted CPU DiT.

No runtime import, model loading, adapter injection or global mutation here.
Metadata rank is deliberately ignored: the down/A tensor defines actual rank.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import math
import re

import torch
from torch import nn

_KEY = re.compile(
    r"lora_unet_layers_(0|[1-9][0-9]*)_"
    r"(proj_(?:q|k|v|o|ffn_up_gate|ffn_down|qkv)|fused_qkv)\."
    r"(lora_down\.weight|lora_up\.weight|alpha)"
)


@dataclass(frozen=True)
class _Update:
    name: str
    weight: torch.Tensor
    a: torch.Tensor
    b: torch.Tensor
    scale: float


def finite_strength(strength) -> float:
    if isinstance(strength, bool) or not isinstance(strength, (int, float)):
        raise ValueError("Style strength must be a finite number.")
    strength = float(strength)
    if not math.isfinite(strength):
        raise ValueError("Style strength must be finite.")
    return strength


def _matrix(value, name):
    if (not isinstance(value, torch.Tensor) or value.ndim != 2
            or min(value.shape) < 1 or not value.is_floating_point()
            or value.layout != torch.strided or value.device.type != "cpu"
            or not bool(torch.isfinite(value).all())):
        raise ValueError(f"Expected a finite, nonempty floating CPU matrix: {name}.")
    # Conversion must itself be finite (e.g. a finite float64 outside FP32 range).
    if not bool(torch.isfinite(value.float()).all()):
        raise ValueError(f"Style tensor exceeds FP32 range: {name}.")
    return value.detach()


def _plan(model, state, strength):
    if not isinstance(state, Mapping) or not state:
        raise ValueError("Style state must be a nonempty tensor mapping.")
    groups = {}
    for key, value in state.items():
        match = _KEY.fullmatch(key) if isinstance(key, str) else None
        if match is None:
            raise ValueError(f"Unknown/unsupported style key (including DoRA): {key!r}.")
        layer, projection, part = match.groups()
        groups.setdefault((layer, projection), {})[part] = value

    updates, targets, storages = [], set(), set()
    for (layer, source_projection), parts in groups.items():
        projection = "qkv" if source_projection == "fused_qkv" else source_projection.removeprefix("proj_")
        label = f"layers.{layer}.proj.{projection}"
        if not {"lora_down.weight", "lora_up.weight"} <= parts.keys():
            raise ValueError(f"Missing style A/B pair: {label}.")
        a = _matrix(parts["lora_down.weight"], f"{label}.A")
        b = _matrix(parts["lora_up.weight"], f"{label}.B")
        rank = a.shape[0]
        if b.shape[1] != rank:
            raise ValueError(f"Style A/B rank shape mismatch: {label}.")
        alpha = parts.get("alpha")
        if alpha is None:
            alpha = float(rank)
        else:
            if (not isinstance(alpha, torch.Tensor) or alpha.numel() != 1
                    or alpha.is_complex() or alpha.dtype == torch.bool
                    or alpha.device.type != "cpu"):
                raise ValueError(f"Style alpha must be a finite scalar: {label}.")
            alpha = float(alpha.item())
            if not math.isfinite(alpha):
                raise ValueError(f"Nonfinite style alpha: {label}.")
        scale = strength * (alpha / rank)
        if not math.isfinite(scale):
            raise ValueError(f"Nonfinite style scale: {label}.")

        names = ("q", "k", "v") if projection == "qkv" else (projection,)
        modules = []
        for name in names:
            target = f"layers.{layer}.proj.{name}"
            try:
                module = model.get_submodule(target)
            except (AttributeError, KeyError, IndexError) as error:
                raise ValueError(f"Unknown style target: {target}.") from error
            # Never merge into edit LoRALinear, Quanto or any opaque wrapper.
            if type(module) is not nn.Linear:
                raise ValueError(f"Style target must be a plain full floating Linear: {target}.")
            weight = _matrix(module.weight, target)
            if weight.shape[1] != a.shape[1]:
                raise ValueError(f"Style A input shape mismatch: {target}.")
            storage = (weight.device, weight.untyped_storage().data_ptr())
            if target in targets or storage in storages:
                raise ValueError(f"Duplicate style target/aliased weight: {target}.")
            targets.add(target)
            storages.add(storage)
            modules.append((target, module.weight))
        sizes = [weight.shape[0] for _, weight in modules]
        if projection == "qkv" and len(set(sizes)) != 1:
            raise ValueError(f"Fused qkv requires three equal output sections: {label}.")
        if b.shape[0] != sum(sizes):
            raise ValueError(f"Style B output shape mismatch: {label}.")
        offset = 0
        for target, weight in modules:
            end = offset + weight.shape[0]
            updates.append(_Update(target, weight, a, b[offset:end], scale))
            offset = end
    return updates


def _merged(update):
    # One full module at a time. FP32 multiplication + addition, then ONE cast.
    result = update.weight.detach().to(dtype=torch.float32, copy=True)
    result.addmm_(update.b.float(), update.a.float(), alpha=update.scale)
    if not bool(torch.isfinite(result).all()):
        raise ValueError(f"Nonfinite FP32 style merge: {update.name}.")
    result = result.to(dtype=update.weight.dtype)
    if not bool(torch.isfinite(result).all()):
        raise ValueError(f"Nonfinite style merge after destination cast: {update.name}.")
    return result


@torch.no_grad()
def merge_style_lora(model, state, strength, *, metadata=None):
    """Validate the entire file before any write; return merged target names.

    Only ordinary Comfy down/up/alpha tensors are supported, including a qkv
    pair whose B rows are [q, k, v] and whose A is shared. Unknown keys, DoRA,
    duplicate destinations, shape errors and nonfinite inputs/results fail
    closed. Safetensors metadata (including rank) does not override tensors.

    Preflight computes and discards one merged module at a time so arithmetic
    overflow in a later module cannot leave an earlier module modified. The
    second pass recomputes then writes; it does not retain a full model delta.
    This is validation atomicity, not rollback on process failure/OOM.
    """
    strength = finite_strength(strength)
    updates = _plan(model, state, strength)
    if strength == 0:
        return ()  # Validate even at zero; preserve bit patterns and versions.
    for update in updates:
        _merged(update)  # All validation/numerical preflight precedes ANY copy_.
    for update in updates:
        update.weight.copy_(_merged(update))
    return tuple(update.name for update in updates)
