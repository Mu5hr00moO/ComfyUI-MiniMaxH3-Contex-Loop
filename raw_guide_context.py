"""Raw masked-AV continuation for the custom ``raw_guide`` chain mode.

Generated scene-to-scene continuation copies the previous sampled H3 video
and audio tails directly into the next target latent. Imported scene-1 context
uses the current H3 video/audio VAE helpers because no sampled predecessor
latent exists yet. Both paths keep the broader native H3 video context grid
used by raw guide (5, 22, 39, ... frames).
"""

from __future__ import annotations

import logging
from typing import Any

import torch

from .masked_context import (
    _encode_imported_audio,
    _encoded_video_tail,
    _existing_mask_streams,
    _generated_video_tail,
    _validate_target_streams,
)
from .nodes import AUDIO_HZ, FPS, VIDEO_RUN_GRID, _audio_tail_from_latent


_LOG = logging.getLogger("minimax_h3_context_loop.raw_guide")
# Must stay identical to guide_nodes.PRESERVED_PREFIX_BOUNDARY_KEY when the
# scene-aware guide nodes are installed.
PRESERVED_PREFIX_BOUNDARY_KEY = "_preserved_prefix_boundary"


def _require_raw_guide_mask_support() -> bool:
    """Enable H3 AV-mask support without requiring the native guide API."""
    from .h3_mask_compat import ensure_h3_mask_compat, is_ready
    from .h3_mask_payload_compat import ensure_av_mask_payload_compat

    ensure_h3_mask_compat()
    ensure_av_mask_payload_compat()
    if not is_ready():
        raise RuntimeError(
            "h3_raw_guide: H3 per-stream AV-mask support could not be "
            "enabled. Check the ComfyUI console capability report."
        )
    return True


def _validate_raw_prefix_frames(context_length: int, target_frames: int) -> int:
    """Validate one raw-guide prefix against H3's native video context grid."""
    frames: int = int(context_length)
    if frames < 5 or frames not in VIDEO_RUN_GRID:
        raise ValueError(
            "h3_raw_guide: context_length must use the H3 video grid "
            "5, 22, 39, 56, ... 243 frames."
        )
    if frames >= int(target_frames):
        raise ValueError(
            "h3_raw_guide: context prefix must be shorter than the target."
        )
    return frames


def _drop_raw_prefix_guides(conditioning: Any, prefix_frames: int) -> Any:
    """Drop conflicting guides but keep the tagged inherited boundary anchor."""
    out: list[list[Any]] = []
    dropped: list[float] = []
    boundary_frame: int = int(prefix_frames) - 1
    for embedding, extra in conditioning:
        metadata = extra.copy()
        kept: list[dict[str, Any]] = []
        for guide in metadata.get("minimax_keyframes") or []:
            position = float(guide.get(
                "resolved_frame_index", guide.get("frame_index", 0)))
            preserve_boundary = (
                bool(guide.get(PRESERVED_PREFIX_BOUNDARY_KEY))
                and position == boundary_frame
            )
            if 0 <= position < int(prefix_frames) and not preserve_boundary:
                dropped.append(position)
                continue

            cleaned_guide = guide
            if PRESERVED_PREFIX_BOUNDARY_KEY in guide:
                cleaned_guide = guide.copy()
                cleaned_guide.pop(PRESERVED_PREFIX_BOUNDARY_KEY, None)
            kept.append(cleaned_guide)
        if "minimax_keyframes" in metadata:
            metadata["minimax_keyframes"] = kept
        out.append([embedding, metadata])
    if dropped:
        _LOG.warning(
            "h3_raw_guide: dropped %d target guide(s) inside preserved "
            "frames 0..%d; the raw target latent already owns that prefix.",
            len(dropped), int(prefix_frames) - 1,
        )
    return out


def _compose_raw_prefix(
    conditioning: Any,
    latent: dict[str, Any],
    target_video: torch.Tensor,
    target_audio: torch.Tensor,
    target_frames: int,
    video_prefix: torch.Tensor,
    video_steps: int,
    audio_prefix: torch.Tensor | None,
    audio_steps: int,
    frames: int,
    source: str,
) -> tuple[Any, dict[str, Any], int]:
    """Copy validated prefix tensors into a cloned target and protect them."""
    if int(video_steps) >= int(target_video.shape[2]):
        raise ValueError(
            "h3_raw_guide: video prefix consumes the whole target latent."
        )
    if audio_prefix is not None and int(audio_steps) >= int(target_audio.shape[-1]):
        raise ValueError(
            "h3_raw_guide: audio prefix consumes the whole target latent."
        )

    out_video: torch.Tensor = target_video.clone()
    out_audio: torch.Tensor = target_audio.clone()
    video_prefix = video_prefix[:1].to(out_video.device, out_video.dtype)
    if (
        int(video_prefix.shape[1]) != int(out_video.shape[1])
        or tuple(video_prefix.shape[3:]) != tuple(out_video.shape[3:])
    ):
        raise ValueError(
            "h3_raw_guide: raw video prefix shape %s does not match target %s."
            % (tuple(video_prefix.shape), tuple(out_video.shape))
        )
    out_video[:, :, :video_steps] = video_prefix

    copied_audio_steps: int = 0
    if audio_prefix is not None:
        audio_prefix = audio_prefix[:1].to(out_audio.device, out_audio.dtype)
        if tuple(audio_prefix.shape[1:3]) != tuple(out_audio.shape[1:3]):
            raise ValueError(
                "h3_raw_guide: raw audio prefix shape %s does not match "
                "target %s."
                % (tuple(audio_prefix.shape), tuple(out_audio.shape))
            )
        out_audio[..., :audio_steps] = audio_prefix
        copied_audio_steps = int(audio_steps)

    video_mask, audio_mask = _existing_mask_streams(
        latent,
        out_video,
        out_audio,
    )
    video_mask[:, :, :video_steps] = 0.0
    if copied_audio_steps:
        audio_mask[..., :copied_audio_steps] = 0.0

    import comfy.nested_tensor

    out_latent: dict[str, Any] = latent.copy()
    out_latent["samples"] = comfy.nested_tensor.NestedTensor(
        (out_video, out_audio)
    )
    out_latent["noise_mask"] = comfy.nested_tensor.NestedTensor(
        (video_mask, audio_mask)
    )
    out_conditioning: Any = _drop_raw_prefix_guides(conditioning, frames)

    _LOG.info(
        "h3_raw_guide: continuation source=%s; %d frames -> %d video / %d "
        "audio latent steps copied; prefix preserved by AV mask; target=%d "
        "frames; trim=%d",
        source,
        frames,
        int(video_steps),
        copied_audio_steps,
        int(target_frames),
        frames,
    )
    return out_conditioning, out_latent, frames


def apply_raw_guide_prefix(
    conditioning: Any,
    latent: dict[str, Any],
    previous_latent: dict[str, Any],
    context_length: int,
    preserve_audio_prefix: bool = True,
) -> tuple[Any, dict[str, Any], int]:
    """Preserve a sampled raw AV tail at the head of the next target latent."""
    _require_raw_guide_mask_support()
    target_video, target_audio, target_frames = _validate_target_streams(latent)
    frames: int = _validate_raw_prefix_frames(context_length, target_frames)

    video_prefix, video_steps = _generated_video_tail(
        previous_latent,
        frames,
        target_video,
    )
    audio_prefix: torch.Tensor | None = None
    audio_steps: int = 0
    if bool(preserve_audio_prefix):
        audio_prefix, audio_steps, overhang = _audio_tail_from_latent(
            previous_latent,
            frames,
        )
        expected_audio_steps: int = int(round(frames / float(FPS) * AUDIO_HZ))
        if int(audio_steps) != expected_audio_steps:
            raise RuntimeError(
                "h3_raw_guide: %d video frames require %d audio steps, got %d."
                % (frames, expected_audio_steps, int(audio_steps))
            )
        if abs(float(overhang)) > 1e-9:
            _LOG.warning(
                "h3_raw_guide: predecessor audio grid ends %.3f latent steps "
                "from its last video frame; copied prefix remains end-aligned.",
                float(overhang),
            )

    return _compose_raw_prefix(
        conditioning=conditioning,
        latent=latent,
        target_video=target_video,
        target_audio=target_audio,
        target_frames=target_frames,
        video_prefix=video_prefix,
        video_steps=int(video_steps),
        audio_prefix=audio_prefix,
        audio_steps=int(audio_steps),
        frames=frames,
        source="previous sampled raw AV latent",
    )


def apply_raw_guide_imported_prefix(
    conditioning: Any,
    vae: Any,
    latent: dict[str, Any],
    previous_frames: torch.Tensor,
    context_length: int,
    crop: str,
    audio_vae: Any = None,
    previous_audio: Any = None,
    preserve_audio_prefix: bool = True,
) -> tuple[Any, dict[str, Any], int]:
    """Use decoded scene-1 context when no sampled predecessor latent exists."""
    _require_raw_guide_mask_support()
    target_video, target_audio, target_frames = _validate_target_streams(latent)
    frames: int = _validate_raw_prefix_frames(context_length, target_frames)
    video_prefix, video_steps = _encoded_video_tail(
        vae,
        previous_frames,
        frames,
        target_video,
        crop,
    )

    audio_prefix: torch.Tensor | None = None
    audio_steps: int = 0
    if bool(preserve_audio_prefix):
        audio_prefix, audio_steps, _audio_source = _encode_imported_audio(
            audio_vae,
            previous_audio,
            frames,
        )
        expected_audio_steps: int = int(round(frames / float(FPS) * AUDIO_HZ))
        if int(audio_steps) != expected_audio_steps:
            raise RuntimeError(
                "h3_raw_guide: %d imported video frames require %d audio "
                "steps, got %d."
                % (frames, expected_audio_steps, int(audio_steps))
            )

    return _compose_raw_prefix(
        conditioning=conditioning,
        latent=latent,
        target_video=target_video,
        target_audio=target_audio,
        target_frames=target_frames,
        video_prefix=video_prefix,
        video_steps=int(video_steps),
        audio_prefix=audio_prefix,
        audio_steps=int(audio_steps),
        frames=frames,
        source="imported decoded frames/audio via H3 VAEs",
    )
