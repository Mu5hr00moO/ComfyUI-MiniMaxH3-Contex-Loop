#!/usr/bin/env python3
"""CPU routing test for MiniMax H3 raw-latent guide continuation."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
from typing import Any


ROOT: pathlib.Path = pathlib.Path(__file__).resolve().parents[1]
COMFY_CANDIDATES: tuple[pathlib.Path, ...] = (
    ROOT.parents[1],
    ROOT.parent / "Comfyui",
    ROOT.parent / "ComfyUI",
)
COMFY: pathlib.Path | None = next(
    (
        path
        for path in COMFY_CANDIDATES
        if (path / "comfy" / "options.py").is_file()
    ),
    None,
)
if COMFY is None:
    raise SystemExit("ComfyUI checkout not found")

sys.path.insert(0, str(COMFY))
sys.argv = ["h3-latent-guide-test", "--cpu"]

import comfy.options  # noqa: E402

comfy.options.enable_args_parsing()

import torch  # noqa: E402


def load_package() -> tuple[Any, Any]:
    """Load the custom-node package and return it with chain_nodes."""
    spec = importlib.util.spec_from_file_location(
        "h3_latent_guide_test_package",
        ROOT / "__init__.py",
        submodule_search_locations=[str(ROOT)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not create the package import specification.")

    package = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = package
    spec.loader.exec_module(package)
    return package, sys.modules[spec.name + ".chain_nodes"]


def make_plan(
    chain: Any,
    *,
    continuation_mode: str,
    context_length: int = 5,
    encode_mode: str = "video",
) -> dict[str, Any]:
    """Build a minimal two-scene plan for continuation routing tests."""
    return chain._normalize_plan(
        json.dumps(
            {
                "shots": [
                    {"id": "one", "prompt": "first", "length": 22},
                    {"id": "two", "prompt": "second", "length": 22},
                ]
            }
        ),
        "latent_guide_routing",
        32,
        32,
        context_length,
        encode_mode,
        "head",
        "disabled",
        "source_track",
        0,
        1.0,
        2,
        1,
        30,
        continuation_mode=continuation_mode,
    )


def make_state(
    plan: dict[str, Any],
    *,
    index: int,
    previous_frames: torch.Tensor,
    previous_latent: Any,
    external_context: bool = False,
) -> dict[str, Any]:
    """Build only the chain-state fields consumed by Chain Context."""
    return {
        "plan": plan,
        "index": index,
        "previous_frames": previous_frames,
        "previous_latent": previous_latent,
        "previous_audio": None,
        "external_context": external_context,
    }


def capture_context_call(
    chain: Any,
    state: dict[str, Any],
) -> tuple[tuple[Any, ...], dict[str, Any]]:
    """Run Chain Context with a fake Motion Context and capture its inputs."""
    captured: dict[str, Any] = {}

    class FakeMotionContext:
        def apply(self, **kwargs: Any) -> tuple[str, int]:
            captured.update(kwargs)
            return ("continued", int(kwargs["context_length"]))

    real_motion_context: Any = chain.MiniMaxH3MotionContext
    chain.MiniMaxH3MotionContext = FakeMotionContext
    try:
        target_latent: dict[str, Any] = {"samples": "target"}
        result: tuple[Any, ...] = chain.MiniMaxH3ChainContext().apply(
            state,
            [["conditioning", {}]],
            object(),
            target_latent,
        )
    finally:
        chain.MiniMaxH3MotionContext = real_motion_context

    return result, captured


def expect_value_error(callable_: Any, expected_text: str) -> None:
    """Require a ValueError containing the expected diagnostic text."""
    try:
        callable_()
    except ValueError as error:
        assert expected_text in str(error), str(error)
    else:
        raise AssertionError(
            f"Expected ValueError containing {expected_text!r}."
        )


def main() -> None:
    """Verify raw-latent routing, legacy routing, fallback, and validation."""
    _package, chain = load_package()

    latent_plan: dict[str, Any] = make_plan(
        chain,
        continuation_mode="latent_guide",
    )
    assert latent_plan["compatibility"]["continuation_mode"] == "latent_guide"

    previous_frames: torch.Tensor = torch.zeros(
        (5, 32, 32, 3),
        dtype=torch.float32,
    )
    previous_latent: dict[str, Any] = {"samples": "previous"}

    latent_state: dict[str, Any] = make_state(
        latent_plan,
        index=2,
        previous_frames=previous_frames,
        previous_latent=previous_latent,
    )
    latent_result, latent_call = capture_context_call(chain, latent_state)

    assert latent_result[:3] == ("continued", 5, True)
    assert latent_call["context_video_latent"] is previous_latent
    assert latent_call["context_latent"] is None
    assert latent_call["context_frames"] is previous_frames
    assert latent_call["context_length"] == 5
    assert latent_call["encode_mode"] == "video"
    assert latent_call["audio_context_length"] == 0

    guide_plan: dict[str, Any] = make_plan(
        chain,
        continuation_mode="guide",
    )
    assert "continuation_mode" not in guide_plan["compatibility"]

    guide_state: dict[str, Any] = make_state(
        guide_plan,
        index=2,
        previous_frames=previous_frames,
        previous_latent=previous_latent,
    )
    _guide_result, guide_call = capture_context_call(chain, guide_state)
    assert guide_call["context_video_latent"] is None
    assert guide_call["context_latent"] is None

    missing_latent_state: dict[str, Any] = make_state(
        latent_plan,
        index=2,
        previous_frames=previous_frames,
        previous_latent=None,
    )
    expect_value_error(
        lambda: chain.MiniMaxH3ChainContext().apply(
            missing_latent_state,
            [["conditioning", {}]],
            object(),
            {"samples": "target"},
        ),
        "no previous sampled AV latent",
    )

    external_state: dict[str, Any] = make_state(
        latent_plan,
        index=1,
        previous_frames=previous_frames,
        previous_latent=None,
        external_context=True,
    )
    external_result, external_call = capture_context_call(chain, external_state)
    assert external_result[:3] == ("continued", 5, True)
    assert external_call["context_video_latent"] is None
    assert external_call["context_frames"] is previous_frames

    expect_value_error(
        lambda: make_plan(
            chain,
            continuation_mode="latent_guide",
            context_length=1,
        ),
        "at least 5 frames",
    )
    expect_value_error(
        lambda: make_plan(
            chain,
            continuation_mode="latent_guide",
            encode_mode="frames",
        ),
        "requires encode_mode=video",
    )

    print(
        "latent guide chain: raw sampled video latent routed only for generated "
        "continuations; guide remains legacy, imported scene-1 context falls "
        "back safely, and invalid latent-guide plans are rejected"
    )


if __name__ == "__main__":
    main()
