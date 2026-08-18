"""Raw masked-AV continuation for the custom ``latent_guide`` chain mode.

The implementation stays separate from upstream continuation routing while
reusing its mask-validation helpers. Generated scene-to-scene continuation
copies sampled H3 video/audio tails directly into the next target latent.
"""

from __future__ import annotations

import logging
from typing import Any

import torch

from .masked_context import (
    _drop_prefix_guides,
    _existing_mask_streams,
    _validate_target_streams,
)
from .nodes import (
    AUDIO_HZ,
    FPS,
    _audio_tail_from_latent,
    _pixel_frames,
    _video_tail_from_latent,
)


_LOG = logging.getLogger("minimax_h3_context_loop.latent_guide")


def _require_latent_guide_mask_support() -> None:
    """Enable H3 AV-mask support without requiring the native guide API."""
    from .h3_mask_compat import ensure_h3_mask_compat, is_ready
    from .h3_mask_payload_compat import ensure_av_mask_payload_compat

    ensure_h3_mask_compat()
    ensure_av_mask_payload_compat()
    if not is_ready():
        raise RuntimeError(
            "h3_latent_guide: H3 per-stream AV-mask support could not be "
            "enabled. Check the ComfyUI console capability report."
        )


def apply_latent_guide_prefix(
    conditioning: Any,
    latent: dict[str, Any],
    previous_latent: dict[str, Any],
    context_length: int,
) -> tuple[Any, dict[str, Any], int]:
    """Preserve a raw sampled AV tail at the head of the next target latent."""
    _require_latent_guide_mask_support()
    target_video, target_audio, target_frames = _validate_target_streams(latent)

    frames: int = int(context_length)
    if frames < 5:
        raise ValueError(
            "h3_latent_guide: raw masked AV continuation needs at least 5 "
            "context frames."
        )
    if frames >= target_frames:
        raise ValueError(
            "h3_latent_guide: context prefix must be shorter than the target."
        )

    video_prefix: torch.Tensor = _video_tail_from_latent(previous_latent, frames)
    video_steps: int = int(video_prefix.shape[2])
    covered_frames: int = _pixel_frames(video_steps)
    if covered_frames != frames:
        raise RuntimeError(
            "h3_latent_guide: raw video prefix covers "
            f"{covered_frames} frames instead of {frames}."
        )
    if video_steps >= int(target_video.shape[2]):
        raise ValueError(
            "h3_latent_guide: video prefix consumes the whole target latent."
        )

    audio_prefix, audio_steps, overhang = _audio_tail_from_latent(
        previous_latent, frames
    )
    expected_audio_steps: int = int(round(frames / float(FPS) * AUDIO_HZ))
    if int(audio_steps) != expected_audio_steps:
        raise RuntimeError(
            "h3_latent_guide: "
            f"{frames} video frames require {expected_audio_steps} audio "
            f"steps, got {int(audio_steps)}."
        )
    if int(audio_steps) >= int(target_audio.shape[-1]):
        raise ValueError(
            "h3_latent_guide: audio prefix consumes the whole target latent."
        )

    out_video: torch.Tensor = target_video.clone()
    out_audio: torch.Tensor = target_audio.clone()
    vp: torch.Tensor = video_prefix[:1].to(out_video.device, out_video.dtype)
    ap: torch.Tensor = audio_prefix[:1].to(out_audio.device, out_audio.dtype)

    if (
        int(vp.shape[1]) != int(out_video.shape[1])
        or tuple(vp.shape[3:]) != tuple(out_video.shape[3:])
    ):
        raise ValueError(
            "h3_latent_guide: raw video prefix shape "
            f"{tuple(vp.shape)} does not match target {tuple(out_video.shape)}."
        )
    if tuple(ap.shape[1:3]) != tuple(out_audio.shape[1:3]):
        raise ValueError(
            "h3_latent_guide: raw audio prefix shape "
            f"{tuple(ap.shape)} does not match target {tuple(out_audio.shape)}."
        )

    out_video[:, :, :video_steps] = vp
    out_audio[..., :audio_steps] = ap

    video_mask, audio_mask = _existing_mask_streams(latent, out_video, out_audio)
    video_mask[:, :, :video_steps] = 0.0
    audio_mask[..., :audio_steps] = 0.0

    import comfy.nested_tensor

    out_latent: dict[str, Any] = latent.copy()
    out_latent["samples"] = comfy.nested_tensor.NestedTensor(
        (out_video, out_audio)
    )
    out_latent["noise_mask"] = comfy.nested_tensor.NestedTensor(
        (video_mask, audio_mask)
    )
    out_conditioning: Any = _drop_prefix_guides(conditioning, frames)

    if abs(float(overhang)) > 1e-9:
        _LOG.warning(
            "h3_latent_guide: predecessor audio grid ends %.3f latent steps "
            "from its last video frame; copied prefix remains end-aligned.",
            float(overhang),
        )

    _LOG.info(
        "h3_latent_guide: continuation source=previous sampled raw AV latent; "
        "%d frames -> %d video / %d audio latent steps; prefix preserved by "
        "AV mask; target=%d frames; trim=%d",
        frames,
        video_steps,
        int(audio_steps),
        target_frames,
        frames,
    )
    return out_conditioning, out_latent, frames
