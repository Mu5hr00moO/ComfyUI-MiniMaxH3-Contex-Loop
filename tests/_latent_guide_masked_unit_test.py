#!/usr/bin/env python3
"""CPU regression for the custom H3 raw masked-AV latent-guide prefix."""

from __future__ import annotations

import importlib.util
import os
import sys
import types
from typing import Any

import torch
import torch.nn.functional as functional


ROOT: str = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKAGE: str = "h3_latent_guide_mask_test_pkg"


class NestedTensor:
    """Minimal NestedTensor stub used by the CPU regression."""

    def __init__(self, parts: Any) -> None:
        self.parts: tuple[Any, ...] = tuple(parts)

    def unbind(self) -> list[Any]:
        return list(self.parts)


def _install_comfy_stubs() -> None:
    """Install the minimal ComfyUI modules required to load project helpers."""
    comfy = types.ModuleType("comfy")
    comfy.__path__ = []
    utils = types.ModuleType("comfy.utils")

    def common_upscale(
        samples: torch.Tensor,
        width: int,
        height: int,
        _method: str,
        _crop: str,
    ) -> torch.Tensor:
        return functional.interpolate(
            samples,
            size=(height, width),
            mode="bilinear",
            align_corners=False,
        )

    utils.common_upscale = common_upscale
    utils.unpack_latents = lambda value, _shapes: value.unbind()
    nested = types.ModuleType("comfy.nested_tensor")
    nested.NestedTensor = NestedTensor
    comfy.utils = utils
    comfy.nested_tensor = nested
    sys.modules["comfy"] = comfy
    sys.modules["comfy.utils"] = utils
    sys.modules["comfy.nested_tensor"] = nested

    helpers = types.ModuleType("node_helpers")
    helpers.conditioning_set_values = lambda value, *_args, **_kwargs: value
    sys.modules["node_helpers"] = helpers

    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_output_directory = lambda: "/tmp"
    sys.modules["folder_paths"] = folder_paths

    safe = types.ModuleType("safetensors")
    safe_torch = types.ModuleType("safetensors.torch")
    safe_torch.load_file = None
    safe_torch.save_file = None
    safe.torch = safe_torch
    sys.modules["safetensors"] = safe
    sys.modules["safetensors.torch"] = safe_torch


def _load(name: str) -> Any:
    path: str = os.path.join(ROOT, f"{name}.py")
    spec = importlib.util.spec_from_file_location(f"{PACKAGE}.{name}", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {path}.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> None:
    """Verify raw AV prefix copying, masks, guide filtering, and cloning."""
    _install_comfy_stubs()
    package = types.ModuleType(PACKAGE)
    package.__path__ = [ROOT]
    sys.modules[PACKAGE] = package

    # nodes.py imports these modules even though this test bypasses patch use.
    patch_layout = types.ModuleType(f"{PACKAGE}.patch_layout")
    patch_layout.MC_KEY = "mc_key"
    patch_layout.MC_AUDIO_KEY = "mc_audio_key"
    patch_layout.apply_patch = lambda: True
    patch_layout.claim_patch_ownership = lambda: (True, "test")
    patch_layout.is_applied = lambda: True
    patch_layout.native_guides_available = lambda: True
    sys.modules[patch_layout.__name__] = patch_layout

    patch_payload = types.ModuleType(f"{PACKAGE}.patch_payload")
    patch_payload.apply_patch = lambda: True
    patch_payload.claim_patch_ownership = lambda: (True, "test")
    patch_payload.is_applied = lambda: True
    sys.modules[patch_payload.__name__] = patch_payload

    nodes = _load("nodes")
    _load("masked_context")
    custom = _load("latent_guide_context")
    custom._require_h3_mask_support = lambda: None

    target_frames: int = 192
    target_video_steps: int = 57
    target_audio_steps: int = 320
    assert nodes._pixel_frames(target_video_steps) == target_frames

    target_video = torch.full(
        (1, 24, target_video_steps, 2, 3), -1.0, dtype=torch.float32
    )
    target_audio = torch.full(
        (1, 32, 2, target_audio_steps), -2.0, dtype=torch.float32
    )
    target = {"samples": NestedTensor((target_video, target_audio))}

    previous_video = torch.empty_like(target_video)
    for step in range(target_video_steps):
        previous_video[:, :, step].fill_(float(step + 1))
    previous_audio = torch.arange(
        1 * 32 * 2 * target_audio_steps,
        dtype=torch.float32,
    ).reshape(1, 32, 2, target_audio_steps)
    previous = {
        "samples": NestedTensor((previous_video, previous_audio)),
    }

    refs = [{"kind": "image", "latent_h": 2, "latent_w": 3}]
    conditioning = [["embedding", {
        "minimax_refs": refs,
        "minimax_keyframes": [
            {"resolved_frame_index": 0, "name": "conflicting first"},
            {"resolved_frame_index": 191, "name": "retained last"},
        ],
    }]]

    out_conditioning, out, trim = custom.apply_latent_guide_prefix(
        conditioning=conditioning,
        latent=target,
        previous_latent=previous,
        context_length=39,
    )

    assert trim == 39
    video, audio = out["samples"].unbind()
    video_mask, audio_mask = out["noise_mask"].unbind()
    prefix_video_steps: int = 12
    prefix_audio_steps: int = 65

    assert nodes._pixel_frames(prefix_video_steps) == 39
    assert torch.equal(
        video[:, :, :prefix_video_steps],
        previous_video[:, :, -prefix_video_steps:],
    )
    assert torch.equal(
        video[:, :, prefix_video_steps:],
        target_video[:, :, prefix_video_steps:],
    )
    assert torch.equal(
        audio[..., :prefix_audio_steps],
        previous_audio[..., -prefix_audio_steps:],
    )
    assert torch.equal(
        audio[..., prefix_audio_steps:],
        target_audio[..., prefix_audio_steps:],
    )
    assert not torch.count_nonzero(video_mask[:, :, :prefix_video_steps])
    assert torch.all(video_mask[:, :, prefix_video_steps:] == 1.0)
    assert not torch.count_nonzero(audio_mask[..., :prefix_audio_steps])
    assert torch.all(audio_mask[..., prefix_audio_steps:] == 1.0)

    metadata = out_conditioning[0][1]
    assert metadata["minimax_refs"] is refs
    assert [item["name"] for item in metadata["minimax_keyframes"]] == [
        "retained last"
    ]
    assert torch.all(target_video == -1.0)
    assert torch.all(target_audio == -2.0)

    print(
        "latent guide masked AV: 39 frames -> 12 video / 65 audio steps; "
        "raw sampled prefixes copied, future target preserved, masks applied, "
        "and conflicting guides dropped"
    )


if __name__ == "__main__":
    main()
