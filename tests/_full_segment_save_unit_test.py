#!/usr/bin/env python3
"""Regression test for diagnostic full-segment saving."""

import importlib.util
import pathlib
import sys
import tempfile
import types


ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = "h3_full_segment_save_unit"

folder_paths = types.ModuleType("folder_paths")
folder_paths.get_output_directory = lambda: folder_paths.output_directory
folder_paths.get_temp_directory = lambda: folder_paths.output_directory
folder_paths.get_input_directory = lambda: folder_paths.output_directory
folder_paths.get_annotated_filepath = lambda value: str(value)
folder_paths.output_directory = str(ROOT)
sys.modules["folder_paths"] = folder_paths

package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT)]
sys.modules[PACKAGE] = package

shared_nodes = types.ModuleType(PACKAGE + ".nodes")
shared_nodes.MiniMaxH3MotionContext = object
shared_nodes._claim_inline_patch_ownership = lambda: "test patch owner"
shared_nodes._prepare_native_guide_conditioning = lambda *args: None
shared_nodes._resize = lambda *args: None
shared_nodes._streams_from_latent = lambda *args: None
sys.modules[shared_nodes.__name__] = shared_nodes

chain_spec = importlib.util.spec_from_file_location(
    PACKAGE + ".chain_nodes", ROOT / "chain_nodes.py")
chain = importlib.util.module_from_spec(chain_spec)
sys.modules[chain_spec.name] = chain
chain_spec.loader.exec_module(chain)

full_spec = importlib.util.spec_from_file_location(
    PACKAGE + ".full_segment_nodes", ROOT / "full_segment_nodes.py")
full = importlib.util.module_from_spec(full_spec)
sys.modules[full_spec.name] = full
full_spec.loader.exec_module(full)


class FakeFullImages:
    shape = (7, 1, 1, 3)


class WrongFullImages:
    shape = (6, 1, 1, 3)


def main():
    inputs = full.MiniMaxH3ChainFullSegmentSave.INPUT_TYPES()
    assert "images_before_trim" in inputs["required"]

    plan = {
        "segment_crf": 18,
        "shots": [{
            "id": "scene_one",
            "prompt": "test prompt",
            "scene_prompt": "test scene",
            "prompt_hash": "test-hash",
            "seed": 1,
            "raw_frames": 7,
        }],
    }
    state = {"plan": plan, "index": 1}
    node = full.MiniMaxH3ChainFullSegmentSave()

    base_calls = []

    def fake_base_save(self, *args, **kwargs):
        base_calls.append((args, kwargs))
        return {
            "ui": {"text": ["base"]},
            "result": (
                {"revision": "abc123"},
                "base status",
            ),
        }

    chain.MiniMaxH3ChainSegmentSave.save = fake_base_save

    try:
        node.save(state, object(), object(), WrongFullImages())
    except ValueError as exc:
        assert "received 6 full decoded frames; expected 7 raw frames" in str(exc)
    else:
        raise AssertionError("images_before_trim frame-count validation did not fire")
    assert not base_calls

    with tempfile.TemporaryDirectory() as tempdir:
        chain._run_dir = lambda _plan: tempdir
        write_calls = []

        def fake_write(images, path, fps, crf, metadata=None):
            write_calls.append({
                "images": images,
                "path": path,
                "fps": fps,
                "crf": crf,
                "metadata": metadata,
            })

        chain._write_segment_video = fake_write
        images_before_trim = FakeFullImages()
        result = node.save(state, object(), object(), images_before_trim)

        assert len(base_calls) == 1
        assert len(write_calls) == 1
        call = write_calls[0]
        assert call["images"] is images_before_trim
        assert call["fps"] == chain.FPS
        assert call["crf"] == 18
        assert call["path"] == str(
            pathlib.Path(tempdir) / "full_segments" /
            "clip_0001.abc123.mp4")
        assert call["metadata"]["h3_full_segment"] == "true"
        assert result["result"][0]["revision"] == "abc123"
        assert "full diagnostic" in result["result"][1]

    assert (
        full.FULL_SEGMENT_NODE_CLASS_MAPPINGS[
            "MiniMaxH3ChainFullSegmentSave"
        ] is full.MiniMaxH3ChainFullSegmentSave
    )
    print(
        "H3 full segment save: raw-frame validation, existing encoder reuse, "
        "revision naming, and node mapping pass"
    )


if __name__ == "__main__":
    main()
