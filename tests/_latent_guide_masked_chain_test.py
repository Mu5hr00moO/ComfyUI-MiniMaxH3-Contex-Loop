#!/usr/bin/env python3
"""CPU routing regression for the custom raw masked-AV latent-guide mode."""

from __future__ import annotations

import importlib
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
sys.argv = ["h3-latent-guide-masked-chain-test", "--cpu"]
import comfy.options  # noqa: E402

comfy.options.enable_args_parsing()

import torch  # noqa: E402


def load_package() -> tuple[Any, Any, Any, Any]:
    """Load the node package and continuation modules used by this test."""
    package_name: str = "h3_latent_guide_masked_chain_test_package"
    spec = importlib.util.spec_from_file_location(
        package_name,
        ROOT / "__init__.py",
        submodule_search_locations=[str(ROOT)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not create the package import specification.")
    package = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = package
    spec.loader.exec_module(package)
    chain = sys.modules[spec.name + ".chain_nodes"]
    latent_guide = importlib.import_module(spec.name + ".latent_guide_context")
    masked_context = importlib.import_module(spec.name + ".masked_context")
    return package, chain, latent_guide, masked_context


def make_plan(
    chain: Any,
    *,
    continuation_mode: str,
    context_length: int = 5,
    encode_mode: str = "video",
    anchor_mode: str = "head",
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
        "latent_guide_masked_routing",
        32,
        32,
        context_length,
        encode_mode,
        anchor_mode,
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
    previous_frames: torch.Tensor | None,
    previous_latent: Any,
    previous_audio: Any = None,
    external_context: bool = False,
) -> dict[str, Any]:
    """Build only the chain-state fields consumed by Chain Context."""
    return {
        "plan": plan,
        "index": index,
        "previous_frames": previous_frames,
        "previous_latent": previous_latent,
        "previous_audio": previous_audio,
        "external_context": external_context,
    }


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
    """Verify custom masked routing, upstream separation, and validation."""
    _package, chain, latent_guide, masked_context = load_package()
    conditioning: list[Any] = [["conditioning", {}]]
    target_latent: dict[str, Any] = {"samples": "target"}
    previous_latent: dict[str, Any] = {"samples": "previous"}
    previous_frames: torch.Tensor = torch.zeros(
        (5, 32, 32, 3),
        dtype=torch.float32,
    )

    latent_plan: dict[str, Any] = make_plan(
        chain,
        continuation_mode="latent_guide",
    )
    assert latent_plan["compatibility"]["continuation_mode"] == "latent_guide"

    captured_raw: dict[str, Any] = {}

    def fake_raw_prefix(**kwargs: Any) -> tuple[Any, dict[str, Any], int]:
        captured_raw.update(kwargs)
        return "raw-masked", {"samples": "raw-masked-target"}, 5

    class ForbiddenMotionContext:
        def apply(self, **_kwargs: Any) -> tuple[Any, int]:
            raise AssertionError(
                "latent_guide generated continuation must not use Motion Context"
            )

    real_raw_prefix: Any = latent_guide.apply_latent_guide_prefix
    real_motion_context: Any = chain.MiniMaxH3MotionContext
    latent_guide.apply_latent_guide_prefix = fake_raw_prefix
    chain.MiniMaxH3MotionContext = ForbiddenMotionContext
    try:
        latent_state: dict[str, Any] = make_state(
            latent_plan,
            index=2,
            previous_frames=None,
            previous_latent=previous_latent,
        )
        latent_result: tuple[Any, ...] = chain.MiniMaxH3ChainContext().apply(
            latent_state,
            conditioning,
            object(),
            target_latent,
        )
    finally:
        latent_guide.apply_latent_guide_prefix = real_raw_prefix
        chain.MiniMaxH3MotionContext = real_motion_context

    assert latent_result == (
        "raw-masked",
        5,
        True,
        {"samples": "raw-masked-target"},
    )
    assert captured_raw["conditioning"] is conditioning
    assert captured_raw["latent"] is target_latent
    assert captured_raw["previous_latent"] is previous_latent
    assert captured_raw["context_length"] == 5

    guide_plan: dict[str, Any] = make_plan(
        chain,
        continuation_mode="guide",
    )
    captured_guide: dict[str, Any] = {}

    class FakeMotionContext:
        def apply(self, **kwargs: Any) -> tuple[str, int]:
            captured_guide.update(kwargs)
            return "guide", int(kwargs["context_length"])

    chain.MiniMaxH3MotionContext = FakeMotionContext
    try:
        guide_result: tuple[Any, ...] = chain.MiniMaxH3ChainContext().apply(
            make_state(
                guide_plan,
                index=2,
                previous_frames=previous_frames,
                previous_latent=previous_latent,
            ),
            conditioning,
            object(),
            target_latent,
        )
    finally:
        chain.MiniMaxH3MotionContext = real_motion_context

    assert guide_result[:3] == ("guide", 5, True)
    assert "context_video_latent" not in captured_guide

    expect_value_error(
        lambda: chain.MiniMaxH3ChainContext().apply(
            make_state(
                latent_plan,
                index=2,
                previous_frames=previous_frames,
                previous_latent=None,
            ),
            conditioning,
            object(),
            target_latent,
        ),
        "no previous sampled AV latent",
    )

    captured_external: dict[str, Any] = {}

    def fake_external_prefix(**kwargs: Any) -> tuple[Any, dict[str, Any], int]:
        captured_external.update(kwargs)
        return "external-masked", {"samples": "external-target"}, 5

    real_masked_prefix: Any = masked_context.apply_masked_prefix
    masked_context.apply_masked_prefix = fake_external_prefix
    try:
        external_result: tuple[Any, ...] = chain.MiniMaxH3ChainContext().apply(
            make_state(
                latent_plan,
                index=1,
                previous_frames=previous_frames,
                previous_latent=None,
                external_context=True,
            ),
            conditioning,
            object(),
            target_latent,
        )
    finally:
        masked_context.apply_masked_prefix = real_masked_prefix

    assert external_result == (
        "external-masked",
        5,
        True,
        {"samples": "external-target"},
    )
    assert captured_external["previous_latent"] is None
    assert captured_external["previous_frames"] is previous_frames
    assert captured_external["context_length"] == 5

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
    expect_value_error(
        lambda: make_plan(
            chain,
            continuation_mode="latent_guide",
            anchor_mode="before",
        ),
        "requires anchor_mode=head",
    )

    print(
        "latent guide chain masked AV: generated continuation routes through "
        "the custom raw masked-prefix core, guide remains upstream, external "
        "scene 1 uses the explicit masked VAE fallback, and invalid plans are "
        "rejected"
    )


if __name__ == "__main__":
    main()
