#!/usr/bin/env python3
"""Standalone regression for generated-audio overlap ownership."""

import importlib.util
import pathlib
import sys
import types

import torch


ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = "h3_audio_overlap_ownership_unit"
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
shared_nodes._prepare_native_guide_conditioning = lambda *args: None
shared_nodes._resize = lambda *args: None
shared_nodes._streams_from_latent = lambda *args: None
sys.modules[shared_nodes.__name__] = shared_nodes

prompt_history = types.ModuleType(PACKAGE + ".prompt_history")
prompt_history.PromptHistoryStore = object
sys.modules[prompt_history.__name__] = prompt_history

prompt_optimizer = types.ModuleType(PACKAGE + ".prompt_optimizer")
prompt_optimizer.optimize_prompt_payload = lambda *args: None
sys.modules[prompt_optimizer.__name__] = prompt_optimizer

run_manager = types.ModuleType(PACKAGE + ".run_manager")
run_manager.RunArchiveManager = object
sys.modules[run_manager.__name__] = run_manager

asset_store = types.ModuleType(PACKAGE + ".asset_store")
asset_store.MAX_ASSET_BINDINGS = 1
asset_store.RunAssetStore = object
sys.modules[asset_store.__name__] = asset_store

spec = importlib.util.spec_from_file_location(
    PACKAGE + ".chain_nodes", ROOT / "chain_nodes.py")
chain = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = chain
spec.loader.exec_module(chain)


def _manifest() -> dict:
    return {"segments": [
        {
            "index": 1,
            "checkpoint": "clip_0001.safetensors",
            "sample_rate": 24,
            "raw_frames": 5,
            "delivered_frames": 5,
        },
        {
            "index": 2,
            "checkpoint": "clip_0002.safetensors",
            "sample_rate": 24,
            "raw_frames": 5,
            "delivered_frames": 3,
        },
    ]}


def main() -> None:
    original_st_load = chain._st_load
    original_absolute_output_path = chain._absolute_output_path
    try:
        chain._absolute_output_path = lambda value: value

        ownership_loads = iter([
            {"delivered_audio": torch.full((1, 2, 5), 1.0)},
            {
                "delivered_audio": torch.full((1, 2, 3), 2.0),
                "overlap_audio": torch.full((1, 2, 5), 9.0),
            },
        ])
        chain._st_load = lambda _path: next(ownership_loads)
        owned = chain._generated_audio(_manifest())
        assert owned["waveform"].shape[-1] == 8
        assert torch.equal(
            owned["waveform"][..., :3], torch.full((1, 2, 3), 1.0))
        assert torch.equal(
            owned["waveform"][..., 3:], torch.full((1, 2, 5), 9.0))

        legacy_loads = iter([
            {"delivered_audio": torch.full((1, 2, 5), 1.0)},
            {"delivered_audio": torch.full((1, 2, 3), 2.0)},
        ])
        chain._st_load = lambda _path: next(legacy_loads)
        legacy = chain._generated_audio(_manifest())
        assert legacy["waveform"].shape[-1] == 8
        assert torch.equal(
            legacy["waveform"][..., :5], torch.full((1, 2, 5), 1.0))
        assert torch.equal(
            legacy["waveform"][..., 5:], torch.full((1, 2, 3), 2.0))
    finally:
        chain._st_load = original_st_load
        chain._absolute_output_path = original_absolute_output_path

    print("H3 audio overlap ownership: new checkpoints replace protected tails")


if __name__ == "__main__":
    main()
