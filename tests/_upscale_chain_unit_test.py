#!/usr/bin/env python3
"""CPU integration test for deferred checkpoint upscale child runs."""

import importlib.util
import json
import pathlib
import sys
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[1]

COMFY_CANDIDATES = [
    ROOT.parent / "Comfyui",
    ROOT.parent / "ComfyUI",
    ROOT.parent.parent,
]

COMFY = next(
    (
        path
        for path in COMFY_CANDIDATES
        if (path / "comfy" / "options.py").is_file()
    ),
    None,
)

if COMFY is None:
    raise SystemExit(
        "ComfyUI checkout not found next to the repo or above custom_nodes"
    )

sys.path.insert(0, str(COMFY))
sys.argv = ["h3-upscale-test", "--cpu"]

import comfy.options  # noqa: E402

comfy.options.enable_args_parsing()
import folder_paths  # noqa: E402
import torch  # noqa: E402
from safetensors import safe_open  # noqa: E402


def load_package():
    spec = importlib.util.spec_from_file_location(
        "h3_upscale_test_package", ROOT / "__init__.py",
        submodule_search_locations=[str(ROOT)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = package
    spec.loader.exec_module(package)
    return (package, sys.modules[spec.name + ".chain_nodes"],
            sys.modules[spec.name + ".upscale_nodes"])


def av_latent(value=0.0):
    return {"samples": [
        torch.full((1, 24, 2, 2, 2), value, dtype=torch.float32),
        torch.full((1, 32, 2, 9), value, dtype=torch.float32),
    ]}


def audio_for_frames(frames, sample_rate=8000):
    samples = round(frames / 24.0 * sample_rate)
    return {
        "waveform": torch.zeros((1, 2, samples), dtype=torch.float32),
        "sample_rate": sample_rate,
    }


def main():
    package, chain, upscale = load_package()
    required = {
        "MiniMaxH3ChainUpscaleAdapter",
        "MiniMaxH3ChainUpscaleCurrent",
        "MiniMaxH3ChainUpscaleSegmentSave",
        "MiniMaxH3ChainUpscaleLoopEnd",
        "MiniMaxH3ChainUpscaleMerge",
    }
    assert required <= set(package.NODE_CLASS_MAPPINGS)
    for name in required:
        node = package.NODE_CLASS_MAPPINGS[name]
        schema = node.INPUT_TYPES()
        for section in ("required", "optional"):
            for input_name, spec in schema.get(section, {}).items():
                options = spec[1] if len(spec) > 1 else {}
                assert str(options.get("tooltip") or "").strip(), (
                    name, input_name)
        assert len(node.OUTPUT_TOOLTIPS) == len(node.RETURN_TYPES), name

    with tempfile.TemporaryDirectory() as temporary:
        folder_paths.output_directory = temporary
        plan = chain.MiniMaxH3ChainPlan().build(
            json.dumps({"shots": [{
                "id": "upscale_scene_1",
                "prompt": "A clean deferred upscale test begins.",
                "length": 5,
                "steps": 2,
                "seed": "7",
            }, {
                "id": "upscale_scene_2",
                "prompt": "The same test continues without a cut.",
                "length": 5,
                "steps": 2,
                "seed": "8",
            }]}),
            "upscale_test", "unit-test", 32, 32, 1,
            "video", "head", "disabled", "generated_audio", 1,
            5 / 24, 2, 7, 18, 0, "guide")[0]
        prepared_plan = chain._plan_with_source_audio(
            chain._plan_with_external_context(plan, None), None)
        state = chain._initial_state(prepared_plan, 1)
        source_images = torch.zeros((5, 32, 32, 3), dtype=torch.float32)
        source = chain.MiniMaxH3ChainSegmentSave().save(
            state, source_images, av_latent(0.25), audio_for_frames(5),
            denoised_latent=av_latent(0.75))["result"][0]
        second_state = chain._initial_state(prepared_plan, 2)
        second_frames = int(prepared_plan["shots"][1]["delivered_frames"])
        source_2 = chain.MiniMaxH3ChainSegmentSave().save(
            second_state,
            torch.zeros((second_frames, 32, 32, 3), dtype=torch.float32),
            av_latent(0.35), audio_for_frames(second_frames),
            denoised_latent=av_latent(0.85))["result"][0]
        source_checkpoint = pathlib.Path(
            chain._absolute_output_path(source["checkpoint"]))
        with safe_open(source_checkpoint, framework="pt", device="cpu") as saved:
            assert {"video", "audio", "denoised_video", "denoised_audio"} <= set(
                saved.keys())

        adapter = upscale.MiniMaxH3ChainUpscaleAdapter()
        flow, upscale_state, source_manifest, _status = adapter.adapt(
            plan, "quality", "h3_latent", '{"scale":2}', 1, 1, False, 18)
        assert source_manifest["segments"][0]["revision"] == source["revision"]
        assert source_manifest["segments"][1]["revision"] == source_2["revision"]
        current = upscale.MiniMaxH3ChainUpscaleCurrent().current(upscale_state)
        assert torch.all(chain._streams_from_latent(current[1])[0] == 0.75)
        assert getattr(current[1]["samples"], "is_nested", False)
        assert torch.all(current[2]["samples"] == 0.75)
        assert torch.all(current[3]["samples"] == 0.75)
        assert current[7:10] == (32, 32, 7)
        assert "saved denoised x0" in current[-1]

        hq_images = torch.zeros((5, 64, 64, 3), dtype=torch.float32)
        saved_result = upscale.MiniMaxH3ChainUpscaleSegmentSave().save(
            upscale_state, hq_images)
        hq_segment = saved_result["result"][0]
        assert not hq_segment["latent_saved"]
        hq_checkpoint = pathlib.Path(
            chain._absolute_output_path(hq_segment["checkpoint"]))
        with safe_open(hq_checkpoint, framework="pt", device="cpu") as saved:
            assert "delivered_audio" in saved.keys()
            assert "upscaled_video" not in saved.keys()

        partial = upscale.MiniMaxH3ChainUpscaleLoopEnd().end(
            flow, upscale_state, hq_images, hq_segment)[0]
        assert partial["format"] == "h3_chain_upscale_partial_manifest_v1"

        flow, upscale_state, source_manifest, _status = adapter.adapt(
            plan, "quality", "h3_latent", '{"scale":2}', 2, 0, False, 18)
        assert len(upscale_state["segments"]) == 1
        current = upscale.MiniMaxH3ChainUpscaleCurrent().current(upscale_state)
        assert current[4] == 2
        assert torch.all(current[2]["samples"] == 0.85)
        second_raw = int(source_2["raw_frames"])
        hq_images_2 = torch.zeros(
            (second_raw, 64, 64, 3), dtype=torch.float32)
        hq_segment_2 = upscale.MiniMaxH3ChainUpscaleSegmentSave().save(
            upscale_state, hq_images_2)["result"][0]
        manifest = upscale.MiniMaxH3ChainUpscaleLoopEnd().end(
            flow, upscale_state, hq_images_2, hq_segment_2)[0]
        assert manifest["format"] == "h3_chain_upscale_manifest_v1"
        assert manifest["profile"] == "quality"
        assert len(manifest["segments"]) == 2
        assert not manifest["latent_saving"]
        merged = upscale.MiniMaxH3ChainUpscaleMerge().merge(
            manifest, "generated", "final", 96)["result"][0]
        merged_path = pathlib.Path(merged)
        assert merged_path.is_file() and merged_path.stat().st_size > 0
        assert merged_path.parent == (
            pathlib.Path(temporary) / "h3_chains" / "upscale_test" /
            "upscaled" / "quality" / "final")

        _flow, latent_state, _manifest, _ = adapter.adapt(
            plan, "archive_latent", "h3_latent", "{}", 1, 0, True, 18)
        try:
            upscale.MiniMaxH3ChainUpscaleSegmentSave().save(
                latent_state, hq_images)
        except ValueError as exc:
            assert "received no HQ latent" in str(exc)
        else:
            raise AssertionError("save_latent accepted a missing HQ latent")
        latent_segment = upscale.MiniMaxH3ChainUpscaleSegmentSave().save(
            latent_state, hq_images, av_latent(1.0))["result"][0]
        with safe_open(chain._absolute_output_path(
                latent_segment["checkpoint"]), framework="pt",
                device="cpu") as saved:
            assert {"upscaled_video", "upscaled_audio"} <= set(saved.keys())

    print("H3 upscale child run: denoised source preference, optional HQ latent, "
          "self-contained audio, manifest, and merger pass")


if __name__ == "__main__":
    main()
