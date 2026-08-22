"""Basic contract tests for arbitrary-position MiniMax H3 guide-image nodes."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import sys
import types
from typing import Any


_TESTS_DIR: str = os.path.dirname(os.path.abspath(__file__))
_PKG_DIR: str = os.path.dirname(_TESTS_DIR)


def _install_stubs() -> None:
    """Install the minimal ComfyUI module surface required for import."""
    torch = types.ModuleType("torch")
    torch.Tensor = object
    sys.modules["torch"] = torch

    comfy = types.ModuleType("comfy")
    comfy.__path__ = []
    model_management = types.ModuleType("comfy.model_management")
    nested_tensor = types.ModuleType("comfy.nested_tensor")
    utils = types.ModuleType("comfy.utils")
    comfy.model_management = model_management
    comfy.nested_tensor = nested_tensor
    comfy.utils = utils
    sys.modules["comfy"] = comfy
    sys.modules["comfy.model_management"] = model_management
    sys.modules["comfy.nested_tensor"] = nested_tensor
    sys.modules["comfy.utils"] = utils

    helpers = types.ModuleType("node_helpers")
    sys.modules["node_helpers"] = helpers

    comfy_nodes = types.ModuleType("nodes")
    comfy_nodes.MAX_RESOLUTION = 16384
    sys.modules["nodes"] = comfy_nodes


def _load_module() -> Any:
    """Load guide_nodes.py without importing the full custom-node package."""
    _install_stubs()
    path: str = os.path.join(_PKG_DIR, "guide_nodes.py")
    spec = importlib.util.spec_from_file_location("h3_guide_nodes_test", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load guide_nodes.py for testing.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _assert_raises(error_type: type[Exception], callback: Any) -> None:
    try:
        callback()
    except error_type:
        return
    raise AssertionError(f"Expected {error_type.__name__}.")


def main() -> None:
    module = _load_module()

    assert module._align_frame_count(5) == 5
    assert module._align_frame_count(6) == 22
    assert module._temporal_shape(124) == (124, 37, 207)

    image_a: object = object()
    image_b: object = object()
    builder = module.MiniMaxH3GuideImage()
    first = builder.build(image_a, 80, scene_index=1)[0]
    chain = builder.build(image_b, -1, first, scene_index=2)[0]

    assert len(chain) == 2
    assert chain[0]["scene_index"] == 1
    assert chain[1]["scene_index"] == 2
    resolved = module.MiniMaxH3GuideImagesToVideo._resolve_guides(chain, 124)
    assert [index for index, _item in resolved] == [80, 123]
    assert resolved[0][1]["image"] is image_a
    assert resolved[1][1]["image"] is image_b
    image_c: object = object()
    image_d: object = object()

    scene_chain = (
        {"image": image_a, "frame_index": 0, "scene_index": 1},
        {"image": image_b, "frame_index": -1, "scene_index": 1},
        {"image": image_d, "frame_index": -1, "scene_index": 2},
        {"image": image_c, "frame_index": 80, "scene_index": 2},
    )

    state_scene_2 = {
        "index": 2,
        "plan": {
            "compatibility": {"continuation_mode": "latent_guide"},
            "shots": [
                {
                    "raw_frames": 124,
                    "delivered_frames": 124,
                },
                {
                    "raw_frames": 124,
                    "delivered_frames": 102,
                },
            ],
        },
    }

    scene_2_guides = module.MiniMaxH3GuideImagesToVideo._select_scene_guides(
        scene_chain,
        state_scene_2,
    )

    resolved_scene_2 = module.MiniMaxH3GuideImagesToVideo._resolve_guides(
        scene_2_guides,
        124,
    )

    assert [index for index, _item in resolved_scene_2] == [0, 80, 123]
    assert resolved_scene_2[0][1]["image"] is image_b
    assert resolved_scene_2[1][1]["image"] is image_c
    assert resolved_scene_2[2][1]["image"] is image_d

    assert scene_2_guides[0]["image"] is image_b

    raw_scene_2_guides, prefix_frames = (
        module.MiniMaxH3GuideImagesToVideo._map_visible_guides_to_raw(
            scene_2_guides,
            state_scene_2,
            124,
        )
    )

    assert prefix_frames == 22

    resolved_scene_2 = module.MiniMaxH3GuideImagesToVideo._resolve_guides(
        raw_scene_2_guides,
        124,
    )

    assert [index for index, _item in resolved_scene_2] == [22, 102, 123]
    assert resolved_scene_2[0][1]["image"] is image_b
    assert resolved_scene_2[1][1]["image"] is image_c
    assert resolved_scene_2[2][1]["image"] is image_d

    reversed_chain = (
        {"image": image_b, "frame_index": -1},
        {"image": image_a, "frame_index": 20},
    )
    resolved = module.MiniMaxH3GuideImagesToVideo._resolve_guides(
        reversed_chain,
        124,
    )
    assert [index for index, _item in resolved] == [20, 123]

    duplicate_chain = (
        {"image": image_a, "frame_index": 20},
        {"image": image_b, "frame_index": 20},
    )
    _assert_raises(
        ValueError,
        lambda: module.MiniMaxH3GuideImagesToVideo._resolve_guides(
            duplicate_chain,
            124,
        ),
    )
    _assert_raises(
        ValueError,
        lambda: module.MiniMaxH3GuideImagesToVideo._resolve_guides(
            ({"image": image_a, "frame_index": 124},),
            124,
        ),
    )


    class FakeImage:
        def __getitem__(self, _key: Any) -> Any:
            return self

    class FakeClip:
        def __init__(self) -> None:
            self.images: list[Any] | None = None

        def tokenize(self, prompt: str, images: list[Any] | None = None) -> Any:
            self.images = list(images or [])
            return (prompt, self.images)

        def encode_from_tokens_scheduled(self, tokens: Any) -> Any:
            return [[None, {"tokens": tokens}]]

    class FakeVAE:
        def encode(self, image: Any) -> Any:
            return ("latent", image)

    module._empty_av_latent = (
        lambda width, height, length: ({"samples": object()}, 124)
    )
    module._resize_image = (
        lambda image, width, height, crop: f"resized:{crop}:{id(image)}"
    )

    captured: dict[str, Any] = {}

    def _conditioning_set_values(conditioning: Any, values: dict[str, Any]) -> Any:
        captured["keyframes"] = values["minimax_keyframes"]
        return conditioning

    module.node_helpers.conditioning_set_values = _conditioning_set_values

    verbose_chain = (
        {"image": FakeImage(), "frame_index": 0, "scene_index": 1, "label": "scene1_start"},
        {"image": FakeImage(), "frame_index": -1, "scene_index": 1, "label": "scene1_end"},
        {"image": FakeImage(), "frame_index": -1, "scene_index": 2, "label": "scene2_end"},
    )

    stream = io.StringIO()
    with contextlib.redirect_stdout(stream):
        node = module.MiniMaxH3GuideImagesToVideo()
        node.execute(
            clip=FakeClip(),
            vae=FakeVAE(),
            prompt="test",
            width=544,
            height=960,
            length=124,
            state=state_scene_2,
            verbose=True,
            guide_images=verbose_chain,
        )

    verbose_output = stream.getvalue()
    assert "[MiniMaxH3GuideImages] scene 2: raw_frames=124, delivered_frames=102, prefix_frames=22" in verbose_output
    assert "mapped guide 'scene1_end' visible 0 -> raw 22" in verbose_output
    assert "mapped guide 'scene2_end' visible -1 -> raw 123" in verbose_output
    assert (
        "inherited start guide 'scene1_end' kept as prompt image and anchored "
        "to preserved boundary raw frame 21"
    ) in verbose_output
    assert "attach 2 minimax_keyframe(s)" in verbose_output
    assert [
        int(item["resolved_frame_index"]) for item in captured["keyframes"]
    ] == [21, 123]
    assert captured["keyframes"][0]["_preserved_prefix_boundary"] is True

    input_types = module.MiniMaxH3GuideImagesToVideo.INPUT_TYPES()
    assert "state" not in input_types["required"]
    assert "state" in input_types["optional"]

    captured.clear()
    standalone_chain = (
        {"image": FakeImage(), "frame_index": 0, "scene_index": 7},
        {"image": FakeImage(), "frame_index": -1, "scene_index": 9},
    )
    node.execute(
        clip=FakeClip(),
        vae=FakeVAE(),
        prompt="standalone",
        width=544,
        height=960,
        length=124,
        guide_images=standalone_chain,
    )
    assert [
        int(item["resolved_frame_index"]) for item in captured["keyframes"]
    ] == [0, 123]

    assert module.NODE_CLASS_MAPPINGS["MiniMaxH3GuideImage"] is (
        module.MiniMaxH3GuideImage
    )
    assert module.NODE_CLASS_MAPPINGS["MiniMaxH3GuideImagesToVideo"] is (
        module.MiniMaxH3GuideImagesToVideo
    )

    print(
        "guide images: frame-grid alignment, chaining, negative indices, "
        "temporal sorting, duplicate rejection, and node mappings pass"
    )


if __name__ == "__main__":
    main()
