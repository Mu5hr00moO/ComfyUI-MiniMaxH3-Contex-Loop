"""Diagnostic full-segment saving for MiniMax H3 chains.

This module extends the existing chain segment saver without modifying its
implementation.  The normal delivered segment, checkpoint, revision metadata,
audio, and blend artifacts remain owned by ``MiniMaxH3ChainSegmentSave``.
The subclass only adds a second MP4 containing the decoded current sample
before Loop Trim removes the repeated leading context frames.
"""

from __future__ import annotations

import os
from typing import Any

from . import chain_nodes as chain


def _full_segment_path(plan: dict[str, Any], index: int) -> str:
    """Return the canonical diagnostic full-segment path for one scene."""
    return os.path.join(
        chain._run_dir(plan),
        "full_segments",
        "clip_%04d.mp4" % int(index),
    )


def _write_full_segment_video(
    images: Any,
    path: str,
    plan: dict[str, Any],
    shot: dict[str, Any],
    index: int,
) -> None:
    """Write the pre-trim diagnostic MP4 using the proven segment encoder."""
    chain._write_segment_video(
        images,
        path,
        chain.FPS,
        plan["segment_crf"],
        metadata={
            "title": "H3 full scene %d - %s" % (index, shot["id"]),
            "comment": shot["prompt"],
            "description": shot.get("scene_prompt", ""),
            "synopsis": shot["prompt_hash"],
            "h3_prompt": shot["prompt"],
            "h3_seed": str(shot["seed"]),
            "h3_full_segment": "true",
        },
    )


class MiniMaxH3ChainFullSegmentSave(chain.MiniMaxH3ChainSegmentSave):
    """Save the normal chain artifacts plus a decoded pre-trim diagnostic MP4."""

    @classmethod
    def INPUT_TYPES(cls):
        inputs = super().INPUT_TYPES()
        required = dict(inputs["required"])
        required["images_before_trim"] = (
            "IMAGE",
            {
                "tooltip": (
                    "Decoded images from the CURRENT H3 sample BEFORE "
                    "MiniMax H3 Contex Loop Trim. The frame count must exactly "
                    "match this scene's planned raw length."
                ),
            },
        )
        return {**inputs, "required": required}

    DESCRIPTION = (
        "Use the standard H3 Chain Segment Save mechanics for delivered "
        "artifacts and additionally persist the decoded pre-trim sample under "
        "full_segments for visual seam diagnostics."
    )

    def save(
        self,
        state,
        images,
        sampled_latent,
        images_before_trim,
        audio=None,
        images_with_overlap=None,
        denoised_latent=None,
        prompt=None,
        extra_pnginfo=None,
        audio_with_overlap=None,
    ):
        plan = state["plan"]
        index = int(state["index"])
        shot = plan["shots"][index - 1]
        actual_full_frames = int(images_before_trim.shape[0])
        expected_full_frames = int(shot["raw_frames"])
        if actual_full_frames != expected_full_frames:
            raise ValueError(
                "H3 chain clip %d received %d full decoded frames; expected "
                "%d raw frames. Connect images_before_trim directly from the "
                "current VAE Decode output before Loop Trim." %
                (index, actual_full_frames, expected_full_frames)
            )

        result = super().save(
            state,
            images,
            sampled_latent,
            audio=audio,
            images_with_overlap=images_with_overlap,
            denoised_latent=denoised_latent,
            prompt=prompt,
            extra_pnginfo=extra_pnginfo,
            audio_with_overlap=audio_with_overlap,
        )
        segment, status = result["result"]
        canonical_full = _full_segment_path(plan, index)
        os.makedirs(os.path.dirname(canonical_full), exist_ok=True)
        published_full = chain._versioned_path(
            canonical_full, str(segment["revision"]))
        _write_full_segment_video(
            images_before_trim, published_full, plan, shot, index)

        full_status = "%s + full diagnostic %s" % (status, published_full)
        result["ui"]["text"] = [full_status]
        result["result"] = (segment, full_status)
        return result


FULL_SEGMENT_NODE_CLASS_MAPPINGS = {
    "MiniMaxH3ChainFullSegmentSave": MiniMaxH3ChainFullSegmentSave,
}

FULL_SEGMENT_NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3ChainFullSegmentSave": "MiniMax H3 Contex Loop Full Segment Save",
}
