#!/usr/bin/env python3
"""CPU regression for the H3 raw-guide sampled AV prefix core."""

from __future__ import annotations

import importlib.util
import os
import sys
import types
from typing import Any

import torch


ROOT: str = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HARNESS_PATH: str = os.path.join(ROOT, "tests", "_masked_prefix_unit_test.py")


def _load_masked_harness() -> Any:
    """Reuse the current upstream masked-prefix ComfyUI stub environment."""
    spec = importlib.util.spec_from_file_location(
        "h3_raw_guide_current_masked_harness",
        HARNESS_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the masked-prefix unit harness.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> None:
    """Verify raw 22-frame generated/imported continuation semantics."""
    harness = _load_masked_harness()
    harness._install_comfy_stubs()

    package = types.ModuleType(harness.PACKAGE)
    package.__path__ = [ROOT]
    sys.modules[harness.PACKAGE] = package

    harness._load("patch_layout")
    harness._load("patch_payload")
    nodes = harness._load("nodes")
    harness._load("masked_context")
    raw_guide = harness._load("raw_guide_context")

    gate_calls: list[str] = []
    engine = types.ModuleType("%s.h3_mask_compat" % harness.PACKAGE)
    engine.ensure_h3_mask_compat = lambda: gate_calls.append("engine")
    engine.is_ready = lambda: True
    payload = types.ModuleType("%s.h3_mask_payload_compat" % harness.PACKAGE)
    payload.ensure_av_mask_payload_compat = lambda: gate_calls.append("payload")
    sys.modules[engine.__name__] = engine
    sys.modules[payload.__name__] = payload
    assert raw_guide._require_raw_guide_mask_support() is True
    assert gate_calls == ["engine", "payload"]

    target_frames: int = 192
    target_video_steps: int = 57
    target_audio_steps: int = 320
    context_frames: int = 22
    prefix_video_steps: int = 7
    prefix_audio_steps: int = 37

    assert nodes._pixel_frames(target_video_steps) == target_frames
    assert nodes._pixel_frames(prefix_video_steps) == context_frames

    target_video = torch.full(
        (1, 16, target_video_steps, 2, 3),
        -1.0,
        dtype=torch.float32,
    )
    target_audio = torch.full(
        (1, 32, 2, target_audio_steps),
        -2.0,
        dtype=torch.float32,
    )
    target = {"samples": harness.NestedTensor((target_video, target_audio))}

    previous_video = torch.empty_like(target_video)
    for step in range(target_video_steps):
        previous_video[:, :, step].fill_(float(step + 1))
    previous_audio = torch.arange(
        1 * 32 * 2 * target_audio_steps,
        dtype=torch.float32,
    ).reshape(1, 32, 2, target_audio_steps)
    previous = {
        "samples": harness.NestedTensor((previous_video, previous_audio)),
    }

    conditioning = [["embedding", {
        "minimax_keyframes": [
            {"resolved_frame_index": 0, "name": "drop first"},
            {"resolved_frame_index": 21, "name": "drop plain boundary"},
            {
                "resolved_frame_index": 21,
                "name": "keep inherited boundary",
                raw_guide.PRESERVED_PREFIX_BOUNDARY_KEY: True,
            },
            {"resolved_frame_index": 22, "name": "keep after prefix"},
            {"resolved_frame_index": 191, "name": "keep last"},
        ],
    }]]

    out_conditioning, out, trim = raw_guide.apply_raw_guide_prefix(
        conditioning=conditioning,
        latent=target,
        previous_latent=previous,
        context_length=context_frames,
    )

    assert trim == context_frames
    video, audio = out["samples"].unbind()
    video_mask, audio_mask = out["noise_mask"].unbind()
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
    kept_guides = out_conditioning[0][1]["minimax_keyframes"]
    assert [item["name"] for item in kept_guides] == [
        "keep inherited boundary", "keep after prefix", "keep last"]
    assert all(raw_guide.PRESERVED_PREFIX_BOUNDARY_KEY not in item
               for item in kept_guides)
    assert torch.all(target_video == -1.0)
    assert torch.all(target_audio == -2.0)

    class ImportedVideoVAE:
        def encode(self, images):
            assert int(images.shape[0]) == context_frames
            return torch.full(
                (1, 16, prefix_video_steps, 2, 3),
                3.0,
                dtype=torch.float32,
            )

    class ImportedAudioVAE:
        audio_sample_rate = 32000

        def encode(self, _waveform):
            return torch.full(
                (1, 32, 2, prefix_audio_steps),
                4.0,
                dtype=torch.float32,
            )

    imported_frames = torch.zeros((64, 32, 48, 3), dtype=torch.float32)
    imported_audio = {
        "waveform": torch.zeros((1, 1, 32000), dtype=torch.float32),
        "sample_rate": 32000,
    }
    imported_conditioning, imported, imported_trim = (
        raw_guide.apply_raw_guide_imported_prefix(
            conditioning=[["embedding", {"minimax_keyframes": []}]],
            vae=ImportedVideoVAE(),
            latent=target,
            previous_frames=imported_frames,
            context_length=context_frames,
            crop="disabled",
            audio_vae=ImportedAudioVAE(),
            previous_audio=imported_audio,
        )
    )
    assert imported_trim == context_frames
    assert imported_conditioning == [["embedding", {"minimax_keyframes": []}]]
    imported_video, imported_audio_latent = imported["samples"].unbind()
    imported_video_mask, imported_audio_mask = imported["noise_mask"].unbind()
    assert torch.all(imported_video[:, :, :prefix_video_steps] == 3.0)
    assert torch.equal(
        imported_video[:, :, prefix_video_steps:],
        target_video[:, :, prefix_video_steps:],
    )
    assert torch.all(imported_audio_latent[..., :prefix_audio_steps] == 4.0)
    assert torch.equal(
        imported_audio_latent[..., prefix_audio_steps:],
        target_audio[..., prefix_audio_steps:],
    )
    assert not torch.count_nonzero(
        imported_video_mask[:, :, :prefix_video_steps])
    assert not torch.count_nonzero(
        imported_audio_mask[..., :prefix_audio_steps])

    _, video_only, _ = raw_guide.apply_raw_guide_prefix(
        conditioning=[["embedding", {"minimax_keyframes": []}]],
        latent=target,
        previous_latent=previous,
        context_length=context_frames,
        preserve_audio_prefix=False,
    )
    _video_only_stream, open_audio = video_only["samples"].unbind()
    _video_only_mask, open_audio_mask = video_only["noise_mask"].unbind()
    assert torch.equal(open_audio, target_audio)
    assert torch.all(open_audio_mask == 1.0)

    print(
        "raw guide core: 22-frame generated/imported prefixes pass; "
        "mask gate does not require native Guide API"
    )


if __name__ == "__main__":
    main()
