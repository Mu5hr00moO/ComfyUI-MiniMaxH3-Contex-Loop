#!/usr/bin/env python3
"""CPU regression for raw-guide protected-prefix timing and audio ownership."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import types
from typing import Any

import torch


ROOT: pathlib.Path = pathlib.Path(__file__).resolve().parents[1]
PACKAGE: str = "h3_raw_guide_protected_prefix_unit"

folder_paths = types.ModuleType("folder_paths")
folder_paths.get_output_directory = lambda: str(ROOT)
folder_paths.get_temp_directory = lambda: str(ROOT)
folder_paths.get_input_directory = lambda: str(ROOT)
folder_paths.get_annotated_filepath = lambda value: str(value)
sys.modules["folder_paths"] = folder_paths

package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT)]
sys.modules[PACKAGE] = package

shared_nodes = types.ModuleType(PACKAGE + ".nodes")
shared_nodes.MiniMaxH3MotionContext = object
shared_nodes._claim_inline_patch_ownership = lambda: "test patch owner"
shared_nodes._prepare_native_guide_conditioning = lambda value: value
shared_nodes._resize = lambda value, *_args: value
shared_nodes._streams_from_latent = lambda *args: None
sys.modules[shared_nodes.__name__] = shared_nodes

spec = importlib.util.spec_from_file_location(
    PACKAGE + ".chain_nodes", ROOT / "chain_nodes.py")
if spec is None or spec.loader is None:
    raise RuntimeError("Could not load chain_nodes.py.")
chain = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = chain
spec.loader.exec_module(chain)


def raw_plan(audio_context_length: int = 22) -> dict[str, Any]:
    return chain._normalize_plan(
        json.dumps({"shots": [
            {"id": "one", "prompt": "one", "length": 56},
            {"id": "two", "prompt": "two", "length": 56},
        ]}),
        "raw-protected-prefix",
        64,
        64,
        22,
        "video",
        "head",
        "disabled",
        "generated_audio",
        audio_context_length,
        1.0,
        8,
        11,
        18,
        "body:auto:v1",
        0,
        "raw_guide",
    )


def generated_audio_manifest() -> dict[str, Any]:
    return {
        "compatibility": {"continuation_mode": "raw_guide"},
        "segments": [
            {
                "index": 1,
                "checkpoint": "clip_0001.safetensors",
                "sample_rate": 24,
                "raw_frames": 56,
                "delivered_frames": 56,
                "continuation_mode": "raw_guide",
            },
            {
                "index": 2,
                "checkpoint": "clip_0002.safetensors",
                "sample_rate": 24,
                "raw_frames": 56,
                "delivered_frames": 34,
                "continuation_mode": "raw_guide",
            },
        ],
    }


def main() -> None:
    assert chain.RAW_GUIDE_CONTINUATION_MODES == frozenset(("raw_guide",))
    assert "raw_guide" not in chain.MASKED_CONTINUATION_MODES
    assert chain.PROTECTED_PREFIX_CONTINUATION_MODES == (
        chain.RAW_GUIDE_CONTINUATION_MODES |
        chain.MASKED_CONTINUATION_MODES
    )

    plan = raw_plan()
    dependency = chain._scene_dependency_record(plan, 2, None)
    assert dependency["scopes"]["incoming_boundary"][
        "masked_audio_contract"] == chain.MASKED_AUDIO_CONTRACT

    reference_entry = {
        "kind": "video",
        "tag": "performance",
        "timeline_mode": "sequential",
        "semantic_role": "motion",
        "ranges": (),
        "value": torch.arange(
            700, dtype=torch.float32
        ).reshape(700, 1, 1, 1).expand(-1, 2, 2, 3),
        "audio": {
            "waveform": torch.arange(
                7000, dtype=torch.float32
            ).reshape(1, 1, 7000),
            "sample_rate": 240,
        },
    }
    motion_state = {
        "index": 2,
        "plan": {
            "compatibility": {"continuation_mode": "raw_guide"},
            "shots": [
                {
                    "raw_frames": 362,
                    "delivered_frames": 362,
                    "generation_start_frame": 0,
                    "prompt": "Begin @performance.",
                },
                {
                    "raw_frames": 345,
                    "delivered_frames": 323,
                    "generation_start_frame": 340,
                    "prompt": "Continue @performance.",
                },
            ],
        },
    }

    window = chain._preflight_reference_window(
        reference_entry, motion_state["plan"], 2)
    assert window == {
        "mode": "sequential",
        "start_frame": 362,
        "end_frame": 685,
        "frame_count": 323,
    }

    motion_video, motion_audio, detail = (
        chain._scheduled_video_reference_slice(
            reference_entry, motion_state, 2, 2, 345))
    assert tuple(motion_video.shape) == (323, 2, 2, 3)
    assert float(motion_video[0, 0, 0, 0]) == 362
    assert float(motion_video[-1, 0, 0, 0]) == 684
    assert tuple(motion_audio["waveform"].shape) == (1, 1, 3450)
    assert float(motion_audio["waveform"][0, 0, 0]) == 3400
    assert detail == (
        "@performance sequential delivered video frames 362:685; paired "
        "audio raw frames 340:685 (origin scene 1)"
    )

    external_plan = raw_plan(audio_context_length=5)
    source_frames = torch.zeros((30, 64, 64, 3), dtype=torch.float32)
    source_audio = {
        "waveform": torch.arange(
            300, dtype=torch.float32).reshape(1, 1, 300),
        "sample_rate": 240,
    }
    external_context, _status = chain.MiniMaxH3ChainExternalVideo().prepare(
        external_plan,
        source_frames=source_frames,
        source_fps=24.0,
        prepend_original=False,
        source_audio=source_audio,
    )
    assert int(external_context["context_frames"].shape[0]) == 22
    assert int(
        external_context["context_audio"]["waveform"].shape[-1]) == 220

    original_load = chain._st_load
    original_path = chain._absolute_output_path
    try:
        chain._absolute_output_path = lambda value: value
        loads = iter([
            {"delivered_audio": torch.full((1, 2, 56), 1.0)},
            {
                "delivered_audio": torch.full((1, 2, 34), 2.0),
                "audio_with_overlap": torch.full((1, 2, 56), 9.0),
            },
        ])
        chain._st_load = lambda _path: next(loads)
        owned = chain._generated_audio(generated_audio_manifest())
        assert tuple(owned["waveform"].shape) == (1, 2, 90)
        assert torch.equal(
            owned["waveform"][..., :34],
            torch.full((1, 2, 34), 1.0),
        )
        assert torch.equal(
            owned["waveform"][..., 34:],
            torch.full((1, 2, 56), 9.0),
        )

        first_manifest = {
            "compatibility": {"continuation_mode": "raw_guide"},
            "segments": [{
                "index": 1,
                "checkpoint": "clip_0001.safetensors",
                "sample_rate": 24,
                "raw_frames": 56,
                "delivered_frames": 34,
                "continuation_mode": "raw_guide",
            }],
        }
        chain._st_load = lambda _path: {
            "delivered_audio": torch.full((1, 2, 34), 2.0),
            "audio_with_overlap": torch.full((1, 2, 56), 9.0),
        }
        first = chain._generated_audio(first_manifest)
        assert torch.equal(
            first[chain.AUDIO_WITH_OVERLAP_WAVEFORM_KEY],
            torch.full((1, 2, 56), 9.0),
        )
        assert first[chain.AUDIO_WITH_OVERLAP_FRAMES_KEY] == 56
        assert first[chain.AUDIO_TRIM_FRAMES_KEY] == 22
    finally:
        chain._st_load = original_load
        chain._absolute_output_path = original_path

    print(
        "raw guide protected prefix: dependency clock, motion timing, "
        "existing-video AV window, generated overlap ownership, and scene-1 "
        "overlap handoff passed"
    )


if __name__ == "__main__":
    main()
