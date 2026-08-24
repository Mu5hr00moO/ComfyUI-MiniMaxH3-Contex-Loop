#!/usr/bin/env python3
"""CPU routing regression for raw-guide integration on the 0.5.18 chain."""

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
sys.argv = ["h3-raw-guide-chain-unit-test", "--cpu"]
import comfy.options  # noqa: E402

comfy.options.enable_args_parsing()

import torch  # noqa: E402


def load_package() -> tuple[Any, Any, Any]:
    """Load the node package plus the chain and raw-guide modules."""
    package_name = "h3_raw_guide_chain_unit_test_package"
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
    raw_guide = importlib.import_module(spec.name + ".raw_guide_context")
    return package, chain, raw_guide


def make_plan(
    chain: Any,
    *,
    continuation_mode: str,
    context_length: int = 22,
    encode_mode: str = "video",
    anchor_mode: str = "head",
    second_scene_generated_continuity: str | None = None,
) -> dict[str, Any]:
    """Build a minimal two-scene plan for continuation routing tests."""
    second_shot: dict[str, Any] = {
        "id": "two",
        "prompt": "second",
        "length": 56,
    }
    if second_scene_generated_continuity is not None:
        second_shot["generated_continuity"] = (
            second_scene_generated_continuity
        )
    return chain._normalize_plan(
        json.dumps({
            "shots": [
                {"id": "one", "prompt": "first", "length": 56},
                second_shot,
            ]
        }),
        "raw_guide_chain_unit",
        32,
        32,
        context_length,
        encode_mode,
        anchor_mode,
        "disabled",
        "generated_audio",
        22,
        2.0,
        2,
        1,
        30,
        continuation_mode=continuation_mode,
    )


def make_state(
    plan: dict[str, Any],
    *,
    index: int,
    previous_frames: Any = None,
    previous_latent: Any = None,
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
            "Expected ValueError containing %r." % expected_text)


def main() -> None:
    """Verify validation, early gate, direct routing, and imported fallback."""
    _package, chain, raw_guide = load_package()
    conditioning: list[Any] = [["conditioning", {}]]
    target_latent: dict[str, Any] = {"samples": "target"}
    previous_latent: dict[str, Any] = {"samples": "previous"}
    previous_frames = torch.zeros((22, 32, 32, 3), dtype=torch.float32)
    model = object()

    assert "raw_guide" in chain.CONTINUATION_MODES
    assert "raw_guide" in chain.RAW_GUIDE_CONTINUATION_MODES
    assert "raw_guide" not in chain.MASKED_CONTINUATION_MODES

    raw_plan = make_plan(chain, continuation_mode="raw_guide")
    assert raw_plan["compatibility"]["continuation_mode"] == "raw_guide"

    captured_raw: dict[str, Any] = {}

    def fake_raw_prefix(**kwargs: Any) -> tuple[Any, dict[str, Any], int]:
        captured_raw.update(kwargs)
        return "raw", {"samples": "raw-target"}, 22

    def forbidden_previous_frames(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError(
            "generated raw_guide must not decode predecessor context frames")

    class ForbiddenMotionContext:
        def apply(self, **_kwargs: Any) -> tuple[Any, int]:
            raise AssertionError("generated raw_guide must not use Motion Context")

    real_raw_prefix = raw_guide.apply_raw_guide_prefix
    real_previous_frames = chain._previous_context_frames
    real_motion_context = chain.MiniMaxH3MotionContext
    raw_guide.apply_raw_guide_prefix = fake_raw_prefix
    chain._previous_context_frames = forbidden_previous_frames
    chain.MiniMaxH3MotionContext = ForbiddenMotionContext
    try:
        raw_result = chain.MiniMaxH3ChainContext().apply(
            make_state(
                raw_plan,
                index=2,
                previous_latent=previous_latent,
            ),
            conditioning,
            object(),
            target_latent,
            model=model,
        )
    finally:
        raw_guide.apply_raw_guide_prefix = real_raw_prefix
        chain._previous_context_frames = real_previous_frames
        chain.MiniMaxH3MotionContext = real_motion_context

    assert raw_result == ("raw", 22, True, {"samples": "raw-target"}, model)
    assert captured_raw["conditioning"] is conditioning
    assert captured_raw["latent"] is target_latent
    assert captured_raw["previous_latent"] is previous_latent
    assert captured_raw["context_length"] == 22
    assert captured_raw["preserve_audio_prefix"] is True

    raw_plan_audio_off = make_plan(
        chain,
        continuation_mode="raw_guide",
        second_scene_generated_continuity="off",
    )
    captured_raw.clear()
    raw_guide.apply_raw_guide_prefix = fake_raw_prefix
    chain._previous_context_frames = forbidden_previous_frames
    chain.MiniMaxH3MotionContext = ForbiddenMotionContext
    try:
        chain.MiniMaxH3ChainContext().apply(
            make_state(
                raw_plan_audio_off,
                index=2,
                previous_latent=previous_latent,
            ),
            conditioning,
            object(),
            target_latent,
            model=model,
        )
    finally:
        raw_guide.apply_raw_guide_prefix = real_raw_prefix
        chain._previous_context_frames = real_previous_frames
        chain.MiniMaxH3MotionContext = real_motion_context

    assert captured_raw["preserve_audio_prefix"] is False

    gate_calls: list[str] = []
    real_raw_gate = raw_guide._require_raw_guide_mask_support
    real_prepare = chain._prepare_native_guide_conditioning
    raw_guide._require_raw_guide_mask_support = (
        lambda: gate_calls.append("raw") or True)
    chain._prepare_native_guide_conditioning = (
        lambda _conditioning: (_ for _ in ()).throw(AssertionError(
            "raw_guide scene-1 preflight must not prepare native guides")))
    try:
        first_result = chain.MiniMaxH3ChainContext().apply(
            make_state(raw_plan, index=1),
            conditioning,
            object(),
            target_latent,
            model=model,
        )
    finally:
        raw_guide._require_raw_guide_mask_support = real_raw_gate
        chain._prepare_native_guide_conditioning = real_prepare
    assert gate_calls == ["raw"]
    assert first_result == (conditioning, 0, False, target_latent, model)

    chain._previous_context_frames = forbidden_previous_frames
    try:
        expect_value_error(
            lambda: chain.MiniMaxH3ChainContext().apply(
                make_state(raw_plan, index=2),
                conditioning,
                object(),
                target_latent,
            ),
            "no previous sampled AV latent",
        )
    finally:
        chain._previous_context_frames = real_previous_frames

    captured_external: dict[str, Any] = {}
    previous_audio = object()
    audio_vae = object()
    frame_calls: list[int] = []

    def fake_imported_prefix(**kwargs: Any) -> tuple[Any, dict[str, Any], int]:
        captured_external.update(kwargs)
        return "external", {"samples": "external-target"}, 22

    real_imported_prefix = raw_guide.apply_raw_guide_imported_prefix
    raw_guide.apply_raw_guide_imported_prefix = fake_imported_prefix
    chain._previous_context_frames = (
        lambda _state, _vae, frames:
        frame_calls.append(int(frames)) or previous_frames)
    try:
        external_result = chain.MiniMaxH3ChainContext().apply(
            make_state(
                raw_plan,
                index=1,
                previous_frames=previous_frames,
                previous_audio=previous_audio,
                external_context=True,
            ),
            conditioning,
            object(),
            target_latent,
            audio_vae=audio_vae,
            model=model,
        )
    finally:
        raw_guide.apply_raw_guide_imported_prefix = real_imported_prefix
        chain._previous_context_frames = real_previous_frames

    assert frame_calls == [22]
    assert external_result == (
        "external", 22, True, {"samples": "external-target"}, model)
    assert captured_external["conditioning"] is conditioning
    assert captured_external["latent"] is target_latent
    assert captured_external["previous_frames"] is previous_frames
    assert captured_external["context_length"] == 22
    assert captured_external["crop"] == "disabled"
    assert captured_external["audio_vae"] is audio_vae
    assert captured_external["previous_audio"] is previous_audio
    assert captured_external["preserve_audio_prefix"] is True

    expect_value_error(
        lambda: make_plan(
            chain,
            continuation_mode="raw_guide",
            context_length=1,
        ),
        "at least 5",
    )
    expect_value_error(
        lambda: make_plan(
            chain,
            continuation_mode="raw_guide",
            encode_mode="frames",
        ),
        "requires encode_mode=video",
    )
    expect_value_error(
        lambda: make_plan(
            chain,
            continuation_mode="raw_guide",
            anchor_mode="before",
        ),
        "requires anchor_mode=head",
    )

    print(
        "raw guide chain 0.5.18: 22-frame validation, early capability gate, "
        "direct sampled-latent routing, imported fallback, and upstream mode "
        "separation passed"
    )


if __name__ == "__main__":
    main()
