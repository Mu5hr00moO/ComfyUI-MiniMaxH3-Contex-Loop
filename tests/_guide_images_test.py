"""Basic contract tests for arbitrary-position MiniMax H3 guide-image nodes."""

from __future__ import annotations

import importlib.util
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
    first = builder.build(image_a, 80)[0]
    chain = builder.build(image_b, -1, first)[0]

    assert len(chain) == 2
    resolved = module.MiniMaxH3GuideImagesToVideo._resolve_guides(chain, 124)
    assert [index for index, _image in resolved] == [80, 123]
    assert resolved[0][1] is image_a
    assert resolved[1][1] is image_b

    reversed_chain = (
        {"image": image_b, "frame_index": -1},
        {"image": image_a, "frame_index": 20},
    )
    resolved = module.MiniMaxH3GuideImagesToVideo._resolve_guides(
        reversed_chain,
        124,
    )
    assert [index for index, _image in resolved] == [20, 123]

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
