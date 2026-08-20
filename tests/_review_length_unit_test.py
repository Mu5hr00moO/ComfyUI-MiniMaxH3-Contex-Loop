#!/usr/bin/env python3
"""Review retry duration updates the complete prepared Plan timeline."""

import asyncio
import importlib.util
import json
import pathlib
import sys
import types
from contextlib import nullcontext

import torch


ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = "h3_review_length_unit"

folder_paths = types.ModuleType("folder_paths")
folder_paths.get_output_directory = lambda: str(ROOT)
folder_paths.get_temp_directory = lambda: str(ROOT)
folder_paths.get_input_directory = lambda: str(ROOT)
folder_paths.get_annotated_filepath = lambda value: str(value)
sys.modules["folder_paths"] = folder_paths

server = types.ModuleType("server")
server.PromptServer = type("PromptServer", (), {"instance": None})
sys.modules["server"] = server

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

spec = importlib.util.spec_from_file_location(
    PACKAGE + ".chain_nodes", ROOT / "chain_nodes.py")
chain = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = chain
spec.loader.exec_module(chain)


def shot(index, raw_frames, delivered_frames, start):
    prompt = "Scene %d." % index
    return {
        "index": index,
        "id": "scene_%d" % index,
        "scene_prompt": prompt,
        "prompt": prompt,
        "prompt_hash": "prompt-%d" % index,
        "seed": index,
        "steps": 20,
        "raw_frames": raw_frames,
        "delivered_frames": delivered_frames,
        "generation_start_frame": start,
        "audio_start_seconds": start / 24,
        "audio_duration_seconds": raw_frames / 24,
    }


plan = {
    "version": 1,
    "run_name": "review_length",
    "prompt_prefix": "",
    "shots": [shot(1, 39, 39, 0), shot(2, 56, 34, 17),
              shot(3, 39, 17, 51)],
    "compatibility": {
        "fps": 24,
        "width": 960,
        "height": 544,
        "context_length": 22,
        "anchor_mode": "head",
        "audio_mode": "generated_audio",
        "source_audio_hash": "none",
    },
    "total_delivered_frames": 90,
    "plan_hash": "prepared-hash",
    "base_plan_hash": "base-hash",
}

revised = chain._plan_with_review_revision(
    plan, 2, "Longer second scene.", 999, 73)

assert revised["shots"][0]["raw_frames"] == 39
assert revised["shots"][1]["raw_frames"] == 73
assert revised["shots"][1]["delivered_frames"] == 51
assert revised["shots"][1]["generation_start_frame"] == 17
assert revised["shots"][2]["generation_start_frame"] == 68
assert revised["shots"][2]["audio_start_seconds"] == 68 / 24
assert revised["total_delivered_frames"] == 107
assert revised["review_overrides"]["2"]["raw_frames"] == 73
assert revised["base_plan_hash"] == plan["base_plan_hash"]
assert chain._history_hash(revised, 1) == chain._history_hash(plan, 1)
assert chain._history_hash(revised, 2) != chain._history_hash(plan, 2)

external = {
    **plan,
    "shots": [shot(1, 56, 34, -22), shot(2, 39, 17, 12)],
    "compatibility": {
        **plan["compatibility"],
        "external_context_frames": 22,
        "external_context_hash": "external-hash",
    },
    "total_delivered_frames": 51,
}
external["shots"][0]["external_context_frames"] = 22
external_revision = chain._plan_with_review_revision(
    external, 1, "Longer imported-video continuation.", 777, 73)
assert external_revision["shots"][0]["generation_start_frame"] == -22
assert external_revision["shots"][0]["delivered_frames"] == 51
assert external_revision["shots"][1]["generation_start_frame"] == 29
assert external_revision["total_delivered_frames"] == 68

try:
    chain._plan_with_review_revision(plan, 2, "Too short.", 999, 22)
except ValueError as exc:
    assert "17k+5" in str(exc) or "continuation overlap" in str(exc)
else:
    raise AssertionError("Review retry accepted an invalid H3 length")


class RetryRequest:
    def __init__(self, token, length):
        self.token = token
        self.length = length

    async def json(self):
        return {
            "token": self.token,
            "action": "retry",
            "scene_prompt": "Route retry.",
            "seed": "123",
            "length": self.length,
        }


async def check_route_validation():
    token = "review-length-test"
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    chain._PENDING_REVIEWS[token] = {
        "future": future,
        "loop": loop,
        "plan": plan,
        "public": {"clip_index": 2, "prompt_prefix": ""},
        "current_seed": 2,
        "current_length": 56,
    }
    try:
        rejected = await chain._submit_review_decision(
            RetryRequest(token, 39))
        assert rejected.status == 400
        assert "next clip requires" in json.loads(rejected.text)["error"]
        assert not future.done()

        accepted = await chain._submit_review_decision(
            RetryRequest(token, 73))
        assert accepted.status == 200
        accepted_body = json.loads(accepted.text)
        assert accepted_body["length"] == 73
        assert accepted_body["scene_prompt"] == "Route retry."
        await asyncio.sleep(0)
        assert future.result()["raw_frames"] == 73
        assert future.result()["scene_prompt"] == "Route retry."
    finally:
        chain._PENDING_REVIEWS.pop(token, None)


asyncio.run(check_route_validation())


assert chain._review_candidate_target(1) == 1
assert chain._review_candidate_target("10") == 10
try:
    chain._review_candidate_target(21)
except ValueError as exc:
    assert "between 1 and 20" in str(exc)
else:
    raise AssertionError("Review Gate accepted too many candidates")


def candidate_segment(revision, seed):
    selected_plan = chain._plan_with_review_revision(
        plan, 2, "Scene 2.", seed, 56)
    return {
        "index": 2,
        "id": "scene_2",
        "revision": revision,
        "segment": "segments/%s.mp4" % revision,
        "checkpoint": "checkpoints/%s.safetensors" % revision,
        "metadata": "checkpoints/clip_0002.json",
        "revision_metadata": "checkpoints/%s.json" % revision,
        "raw_frames": 56,
        "delivered_frames": 34,
        "scene_prompt": "Scene 2.",
        "prompt": "Scene 2.",
        "prompt_hash": selected_plan["shots"][1]["prompt_hash"],
        "history_hash": chain._history_hash(selected_plan, 2),
        "seed": str(seed),
        "steps": 20,
        "checkpoint_sha256": revision,
    }


async def check_candidate_batch():
    sent = []

    class BatchServerInstance:
        client_id = "candidate-client"

        def send_sync(self, event, payload, client_id=None):
            sent.append((event, payload, client_id))

    original_server = chain.PromptServer
    original_review_video = chain._review_video
    original_load_revision = chain._load_checkpoint_revision
    chain.PromptServer = type(
        "BatchServer", (), {"instance": BatchServerInstance()})
    chain._review_video = lambda _plan, segment, _audio, retain_previous=False: (
        {"filename": "%s.mp4" % segment["revision"],
         "subfolder": "candidates", "type": "output"}, True, "")
    first = candidate_segment("a" * 32, 2)
    try:
        first_result = await chain.MiniMaxH3ChainReview().review(
            {"plan": plan, "index": 2, "segments": [{"revision": "parent"}]},
            first, True, False, 0.0, False, False, "none",
            candidate_count=2, unique_id="review-node")
        decision = first_result["result"][0]["_h3_review_decision"]
        assert decision["action"] == "retry"
        assert decision["candidate_batch"]["target"] == 2
        assert len(decision["candidate_batch"]["candidates"]) == 1
        assert decision["seed"] != 2

        second_plan = chain._plan_with_review_revision(
            plan, 2, "Scene 2.", decision["seed"], 56)
        second = candidate_segment("b" * 32, decision["seed"])
        state = {
            "plan": second_plan,
            "index": 2,
            "segments": [{"revision": "parent"}],
            "candidate_batch": decision["candidate_batch"],
        }
        chain._load_checkpoint_revision = lambda _run, _scene, revision: (
            {"segment": first if revision == first["revision"] else second},
            "candidate.json")
        task = asyncio.create_task(chain.MiniMaxH3ChainReview().review(
            state, second, True, False, 0.0, False, False, "none",
            candidate_count=2, unique_id="review-node"))
        for _ in range(100):
            if chain._PENDING_REVIEWS:
                break
            await asyncio.sleep(0.01)
        assert chain._PENDING_REVIEWS
        public = next(iter(chain._PENDING_REVIEWS.values()))["public"]
        assert public["candidate_count"] == 2
        assert [item["revision"] for item in public["candidates"]] == [
            first["revision"], second["revision"]]
        token = public["token"]

        class ChooseCurrent:
            async def json(self):
                return {"token": token, "action": "approve",
                        "candidate_revision": second["revision"]}

        response = await chain._submit_review_decision(ChooseCurrent())
        body = json.loads(response.text)
        assert response.status == 200
        assert body["candidate_number"] == 2
        result = await asyncio.wait_for(task, timeout=2.0)
        assert result["result"][0]["revision"] == second["revision"]
        assert "selected candidate 2/2" in result["result"][1]
    finally:
        chain._PENDING_REVIEWS.clear()
        chain.PromptServer = original_server
        chain._review_video = original_review_video
        chain._load_checkpoint_revision = original_load_revision


asyncio.run(check_candidate_batch())


def check_exact_candidate_selection():
    current_plan = chain._plan_with_review_revision(
        plan, 2, "Scene 2.", 999, 56)
    selected = candidate_segment("c" * 32, 2)
    metadata = {
        "compatibility": plan["compatibility"],
        "segment": selected,
    }
    original_load_revision = chain._load_checkpoint_revision
    original_st_load = chain._st_load
    original_atomic_json = chain._atomic_json
    original_lock = chain.checkpoint_run_lock
    writes = []
    chain._load_checkpoint_revision = lambda *_args: (metadata, "selected.json")
    chain._st_load = lambda _path: {
        "context_frames": torch.zeros((22, 2, 2, 3)),
        "video": torch.zeros((1, 2, 2)),
        "audio": torch.zeros((1, 2, 2)),
    }
    chain._atomic_json = lambda path, value: writes.append((path, value))
    chain.checkpoint_run_lock = lambda *_args: nullcontext()
    try:
        accepted, selected_state = chain._select_review_candidate({
            "plan": current_plan,
            "index": 2,
            "segments": [{"revision": "parent"}],
            "candidate_batch": {"scene": 2},
        }, candidate_segment("d" * 32, 999), {
            "candidate_revision": selected["revision"],
        })
        choice = accepted["_h3_review_decision"]
        assert choice["action"] == "candidate_selected"
        assert choice["plan"]["shots"][1]["seed"] == 2
        assert choice["context_frames"].shape[0] == 22
        assert selected_state["plan"]["shots"][1]["seed"] == 2
        assert "candidate_batch" not in selected_state
        assert writes and writes[0][1] is metadata
    finally:
        chain._load_checkpoint_revision = original_load_revision
        chain._st_load = original_st_load
        chain._atomic_json = original_atomic_json
        chain.checkpoint_run_lock = original_lock


check_exact_candidate_selection()


class FakePromptServerInstance:
    def __init__(self):
        self.client_id = "current-client"
        self.sent = []

    def send_sync(self, event, payload, client_id=None):
        self.sent.append((event, payload, client_id))


fake_prompt_server = FakePromptServerInstance()
chain.PromptServer.instance = fake_prompt_server
final_manifest = {
    "format": "h3_chain_manifest_v3",
    "run_name": "review_length",
    "plan_hash": "prepared-hash",
}
final_key = chain._final_review_preview_key(final_manifest)
chain._PENDING_FINAL_REVIEW_PREVIEWS[final_key] = {
    "token": "final-token",
    "node_id": "review-node",
    "client_id": "originating-client",
}
chain._publish_final_review_preview(
    final_manifest, str(ROOT / "final.mp4"), "assembled final")
assert final_key not in chain._PENDING_FINAL_REVIEW_PREVIEWS
assert fake_prompt_server.sent == [(
    "minimax_h3_context_loop_review_resolved",
    {
        "token": "final-token",
        "node_id": "review-node",
        "action": "final",
        "status": "assembled final",
        "final_video": {
            "filename": "final.mp4",
            "subfolder": "",
            "type": "output",
        },
    },
    "originating-client",
)]

print("H3 Review length and final preview handoff: pass")
