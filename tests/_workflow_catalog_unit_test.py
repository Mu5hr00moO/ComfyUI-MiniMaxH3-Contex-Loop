#!/usr/bin/env python3
"""Type-based H3 example catalog and authoring-level workflow regression."""

import collections
import hashlib
import json
import pathlib


ROOT = pathlib.Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "example_workflows"
ARCHIVE = EXAMPLES / "Archive"
SOURCE_URL = (
    "https://discord.com/channels/1076117621407223829/"
    "1532625331960152124/1536689209761599608"
)
I2V_SOURCE_URL = (
    "https://discord.com/channels/1076117621407223829/"
    "1533677158067736777/1537180042210054226"
)
I2V_ASSET_SHA256 = (
    "7a9993055d71b1e174096f2a2533ae2a0b14a686fdacae0c7bab1faa738ef5f3"
)
FL2V_LAST_ASSET_SHA256 = (
    "e07862c0d5160f06f015b8849dc4b7d2db0524de5ba490fd26c3dff33e196b34"
)


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def node(workflow, node_type):
    matches = [item for item in workflow["nodes"]
               if item.get("type") == node_type]
    assert len(matches) == 1, (node_type, len(matches))
    return matches[0]


def socket(items, name):
    return next(item for item in items if item.get("name") == name)


def prompt_text(value):
    return "\n".join(value) if isinstance(value, list) else str(value)


def comparable_plan(plan):
    defaults = plan.get("defaults") or {}
    return {
        "prompt_prefix": str(plan.get("prompt_prefix", "")),
        "shots": [{
            "id": shot["id"],
            "prompt": prompt_text(shot["prompt"]),
            "length": shot["length"],
            "steps": shot.get("steps", defaults.get("steps")),
            "seed": shot["seed"],
        } for shot in plan["shots"]],
    }


def validate_links(workflow):
    nodes = {item["id"]: item for item in workflow["nodes"]}
    links = {item[0]: item for item in workflow["links"]}
    assert len(nodes) == len(workflow["nodes"])
    assert len(links) == len(workflow["links"])
    assert workflow["last_link_id"] >= max(links)
    for link_id, link in links.items():
        _, origin_id, origin_slot, target_id, target_slot, link_type = link
        assert origin_id in nodes and target_id in nodes
        origin = nodes[origin_id]["outputs"][origin_slot]
        target = nodes[target_id]["inputs"][target_slot]
        assert link_id in (origin.get("links") or [])
        assert target.get("link") == link_id
        # Reroutes and several legacy Comfy workflows serialize the concrete
        # resolved type on the link while retaining "*" or a stale socket type
        # on one endpoint. Structural ownership is the portable invariant.
        assert isinstance(link_type, str) and link_type
    for item in nodes.values():
        for input_value in item.get("inputs") or []:
            link_id = input_value.get("link")
            if link_id is not None:
                assert link_id in links
        for output in item.get("outputs") or []:
            for link_id in output.get("links") or []:
                assert link_id in links


def validate_t2v(path, editor_type, expected_blend):
    workflow = load(path)
    validate_links(workflow)
    node_types = {item.get("type") for item in workflow["nodes"]}
    assert "LoadImage" not in node_types
    assert not node_types.intersection({
        "PathchSageAttentionKJ",
        "MiniMaxH3MemoryEfficientSageAttentionPatch",
        "SolAttnPatch",
    })

    attention = node(workflow, "ModelAttentionBackend")
    assert attention["widgets_values"] == ["comfy kitchen attention"]
    lora = node(workflow, "LoraLoaderModelOnly")
    assert lora["widgets_values"] == [
        "MiniMax H3/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
        1.0,
    ]
    assert socket(attention["inputs"], "model")["link"] is not None
    assert socket(lora["inputs"], "model")["link"] is not None

    conditioner = node(workflow, "MiniMaxH3ImageToVideo")
    assert socket(conditioner["inputs"], "first_frame")["link"] is None
    assert socket(conditioner["inputs"], "last_frame")["link"] is None
    assert conditioner["widgets_values"][1:4] == [544, 960, 243]

    plan_node = node(workflow, "MiniMaxH3ChainPlan")
    plan = json.loads(plan_node["widgets_values"][0])
    assert plan_node["widgets_values"][3:6] == [544, 960, 22]
    assert plan_node["widgets_values"][9] == "generated_audio"
    assert plan_node["widgets_values"][12] == 8
    assert plan_node["widgets_values"][15] == expected_blend
    assert plan["defaults"]["steps"] == 8
    assert node(workflow, "KSamplerSelect")["widgets_values"] == ["lcm"]
    scheduler = node(workflow, "BasicScheduler")
    assert scheduler["widgets_values"][0:2] == ["beta", 8]
    assert len(plan["shots"]) == 2
    assert [shot["length"] for shot in plan["shots"]] == [243, 243]
    for shot in plan["shots"]:
        prompt = "\n".join(shot["prompt"])
        first = prompt.index("integrated_multimodal_description:")
        sound = prompt.index("overall_soundscape:")
        music = prompt.index("non_diegetic_music:")
        assert first == 0 and first < sound < music
        assert "<Picture" not in prompt and "<Video" not in prompt
    assert "I have to be honest with you. I left Wan." in "\n".join(
        plan["shots"][0]["prompt"])

    editor = node(workflow, editor_type)
    assert socket(editor["inputs"], "plan")["link"] is not None
    assert ("MiniMaxH3ChainPlanStudio" in {
        item.get("type") for item in workflow["nodes"]}) == (
            editor_type == "MiniMaxH3ChainPlanStudio")
    rich_editors = [item for item in workflow["nodes"]
                    if item.get("type") ==
                    "MiniMaxH3ChainRichScenePromptEditor"]
    if editor_type == "MiniMaxH3ChainPlanStudio":
        assert len(rich_editors) == 1
        assert socket(rich_editors[0]["inputs"], "plan")["link"] is not None
    else:
        assert not rich_editors

    trim = node(workflow, "MiniMaxH3LoopTrim")
    saver = node(workflow, "MiniMaxH3ChainSegmentSave")
    assert socket(trim["inputs"], "retain_overlap_frames")["link"] is not None
    assert socket(trim["outputs"], "images_with_overlap")["links"]
    assert socket(saver["inputs"], "images_with_overlap")["link"] is not None

    review = node(workflow, "MiniMaxH3ChainReview")
    assert socket(review["inputs"], "source_audio")["link"] is None
    assert review["size"][1] >= 650

    notes = "\n".join(
        str(item.get("widgets_values", [""])[0])
        for item in workflow["nodes"] if item.get("type") == "Note")
    assert "🦙rishappi" in notes and SOURCE_URL in notes
    assert "Scene 2 is a new continuation" in notes
    if expected_blend:
        assert "blends only 5 frames" in notes
    else:
        assert "video_blend_frames = 0" in notes
    return workflow, plan


def validate_i2v(path, editor_type, expected_blend):
    workflow = load(path)
    validate_links(workflow)
    node_types = {item.get("type") for item in workflow["nodes"]}
    assert not node_types.intersection({
        "PathchSageAttentionKJ",
        "MiniMaxH3MemoryEfficientSageAttentionPatch",
        "SolAttnPatch",
    })

    assert node(workflow, "ModelAttentionBackend")["widgets_values"] == [
        "comfy kitchen attention"]
    assert node(workflow, "LoraLoaderModelOnly")["widgets_values"] == [
        "MiniMax H3/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
        1.0,
    ]
    assert node(workflow, "KSamplerSelect")["widgets_values"] == ["lcm"]
    assert node(workflow, "BasicScheduler")["widgets_values"][0:2] == [
        "beta", 8]

    loader = node(workflow, "LoadImage")
    assert loader["widgets_values"][0] == (
        "jigen_market_garden_doom_opening.png")
    gate = node(workflow, "MiniMaxH3ChainFirstSceneImage")
    assert socket(gate["inputs"], "state")["link"] is not None
    assert socket(gate["inputs"], "image")["link"] is not None
    assert socket(gate["inputs"], "last_frame")["link"] is None
    assert socket(gate["outputs"], "last_frame")["links"] is None
    conditioner = node(workflow, "MiniMaxH3ImageToVideo")
    assert socket(conditioner["inputs"], "first_frame")["link"] is not None
    assert socket(conditioner["inputs"], "last_frame")["link"] is None
    assert conditioner["widgets_values"][1:4] == [896, 672, 362]
    assert socket(gate["outputs"], "first_frame")["links"] == [
        socket(conditioner["inputs"], "first_frame")["link"]]

    plan_node = node(workflow, "MiniMaxH3ChainPlan")
    plan = json.loads(plan_node["widgets_values"][0])
    assert plan_node["widgets_values"][3:6] == [896, 672, 22]
    assert plan_node["widgets_values"][9] == "generated_audio"
    assert plan_node["widgets_values"][10:13] == [22, 15, 8]
    assert plan_node["widgets_values"][15] == expected_blend
    assert plan["defaults"] == {"duration_seconds": 15, "steps": 8}
    assert [shot["length"] for shot in plan["shots"]] == [362, 362]
    opening = "\n".join(plan["shots"][0]["prompt"])
    continuation = "\n".join(plan["shots"][1]["prompt"])
    assert opening.startswith(
        "For the target video, at 0.00 seconds into the target video, "
        "<Picture 1> (from [Shot 1]) is fully referenced.")
    assert opening.index("integrated_multimodal_description:") < (
        opening.index("overall_soundscape:")) < opening.index(
            "non_diegetic_music:")
    assert "Classic Doom 1993" in opening and "Market Garden" in opening
    assert continuation.startswith("integrated_multimodal_description:")
    assert "incoming H3 Motion Context" in continuation
    assert "<Picture" not in continuation and "<Video" not in continuation
    assert continuation.index("overall_soundscape:") < continuation.index(
        "non_diegetic_music:")

    editor = node(workflow, editor_type)
    assert socket(editor["inputs"], "plan")["link"] is not None
    rich_editors = [item for item in workflow["nodes"]
                    if item.get("type") ==
                    "MiniMaxH3ChainRichScenePromptEditor"]
    if editor_type == "MiniMaxH3ChainPlanStudio":
        assert len(rich_editors) == 1
        assert socket(rich_editors[0]["inputs"], "plan")["link"] is not None
    else:
        assert not rich_editors

    trim = node(workflow, "MiniMaxH3LoopTrim")
    saver = node(workflow, "MiniMaxH3ChainSegmentSave")
    assert socket(trim["inputs"], "retain_overlap_frames")["link"] is not None
    assert socket(saver["inputs"], "images_with_overlap")["link"] is not None
    notes = "\n".join(
        str(item.get("widgets_values", [""])[0])
        for item in workflow["nodes"] if item.get("type") == "Note")
    assert "ᴊɪɢᴇɴ" in notes and I2V_SOURCE_URL in notes
    assert "Scene 2 is a new continuation" in notes
    assert ("video_blend_frames = 5" if expected_blend
            else "video_blend_frames = 0") in notes
    return workflow, plan


def validate_fl2v(path):
    workflow = load(path)
    validate_links(workflow)
    loaders = [item for item in workflow["nodes"]
               if item.get("type") == "LoadImage"]
    assert {item["widgets_values"][0] for item in loaders} == {
        "jigen_market_garden_doom_opening.png",
        "jigen_market_garden_doom_last.png",
    }

    current = node(workflow, "MiniMaxH3ChainCurrent")
    switch = node(workflow, "MiniMaxH3ChainFrameIndexSwitch")
    gate = node(workflow, "MiniMaxH3ChainFirstSceneImage")
    conditioner = node(workflow, "MiniMaxH3ImageToVideo")
    assert socket(current["outputs"], "clip_index")["links"] == [
        socket(switch["inputs"], "clip_index")["link"]]
    assert socket(switch["inputs"], "frame_1")["link"] is not None
    assert socket(switch["inputs"], "frame_2")["link"] is not None
    assert socket(switch["outputs"], "image")["links"] == [
        socket(gate["inputs"], "last_frame")["link"]]
    assert socket(gate["outputs"], "first_frame")["links"] == [
        socket(conditioner["inputs"], "first_frame")["link"]]
    assert socket(gate["outputs"], "last_frame")["links"] == [
        socket(conditioner["inputs"], "last_frame")["link"]]

    plan_node = node(workflow, "MiniMaxH3ChainPlan")
    plan = json.loads(plan_node["widgets_values"][0])
    assert [shot["length"] for shot in plan["shots"]] == [362, 362]
    first = "\n".join(plan["shots"][0]["prompt"])
    second = "\n".join(plan["shots"][1]["prompt"])
    assert first.startswith(
        "How the reference pictures align with the target video — "
        "Picture 1 (from Shot 1) aligns with the 0.00-second mark")
    assert "Picture 2 (from Shot 1) aligns with the 15.08-second mark" in first
    assert second.startswith(
        "How the reference pictures align with the target video — "
        "<Picture 1> (from [Shot 1]) aligns with the 15.08-second mark")
    for prompt in (first, second):
        assert prompt.index("integrated_multimodal_description:") < (
            prompt.index("overall_soundscape:")) < prompt.index(
                "non_diegetic_music:")
    notes = "\n".join(
        str(item.get("widgets_values", [""])[0])
        for item in workflow["nodes"] if item.get("type") == "Note")
    assert "A→B→A" in notes and "ᴊɪɢᴇɴ" in notes
    assert I2V_SOURCE_URL in notes
    return workflow, plan


def validate_ref2v(path, variant):
    workflow = load(path)
    validate_links(workflow)
    node_types = {item.get("type") for item in workflow["nodes"]}
    assert not node_types.intersection({
        "PathchSageAttentionKJ",
        "MiniMaxH3MemoryEfficientSageAttentionPatch",
        "SolAttnPatch",
    })
    assert node(workflow, "ModelAttentionBackend")["widgets_values"] == [
        "comfy kitchen attention"]
    assert node(workflow, "UNETLoader")["widgets_values"][0] == (
        "MiniMax-H3/minimax_h3_ref2va_pruned_int8_convrot.safetensors")
    assert node(workflow, "LoraLoaderModelOnly")["widgets_values"] == [
        "MiniMax H3/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
        1.0,
    ]
    assert node(workflow, "KSamplerSelect")["widgets_values"] == ["lcm"]
    assert node(workflow, "BasicScheduler")["widgets_values"][0:2] == [
        "beta", 8]

    loaders = [item for item in workflow["nodes"]
               if item.get("type") == "LoadImage"]
    assert len(loaders) == 2
    assert {item["widgets_values"][0] for item in loaders} == {
        "jigen_market_garden_doom_opening.png",
        "jigen_market_garden_doom_last.png",
    }

    plan_node = node(workflow, "MiniMaxH3ChainPlan")
    plan = json.loads(plan_node["widgets_values"][0])
    expected_context = 39 if variant == "studio" else 22
    assert plan_node["widgets_values"][3:6] == [
        896, 672, expected_context]
    expected_audio_mode = (
        "source_track" if variant == "source_audio" else "generated_audio")
    assert plan_node["widgets_values"][9:13] == [
        expected_audio_mode, expected_context, 10, 8]
    defaults = plan.get("defaults")
    if defaults is not None:
        assert defaults == {"duration_seconds": 10, "steps": 8}
    else:
        # Saving through Plan Studio expands defaults into each scene and
        # stores prompts as strings. This is equivalent runtime Plan JSON.
        assert all(shot.get("steps") == 8 for shot in plan["shots"])
    assert [shot["length"] for shot in plan["shots"]] == [243, 243]
    assert [shot["seed"] for shot in plan["shots"]] == ["4201", "4202"]
    for shot in plan["shots"]:
        prompt = prompt_text(shot["prompt"])
        positions = [prompt.index(section) for section in (
            "subject_definitions:", "summary:", "retention_analysis:",
            "detailed_description:", "overall_soundscape:",
            "non_diegetic_music:")]
        assert positions == sorted(positions)
        assert positions[0] == 0

    if variant == "basic":
        conditioner = node(workflow, "MiniMaxH3ReferenceToVideo")
        assert "MiniMaxH3ScheduledReferenceToVideo" not in node_types
        assert "MiniMaxH3TaggedReferenceToVideo" not in node_types
        assert not any(item.get("type") ==
                       "MiniMaxH3ScheduledPictureReference"
                       for item in workflow["nodes"])
        assert socket(conditioner["inputs"],
                      "ref_images.ref_image_0")["link"] is not None
        assert socket(conditioner["inputs"],
                      "ref_images.ref_image_1")["link"] is not None
        prompts = [prompt_text(shot["prompt"]) for shot in plan["shots"]]
        assert all("<Picture 1>" in prompt and "<Picture 2>" in prompt
                   for prompt in prompts)
        assert all("@style_base" not in prompt for prompt in prompts)
        assert "MiniMaxH3ChainRunManager" not in node_types
        editor = node(workflow, "MiniMaxH3ChainScenePromptEditor")
        assert socket(editor["inputs"], "plan")["link"] is not None
    else:
        conditioner = node(workflow, "MiniMaxH3TaggedReferenceToVideo")
        assert conditioner["widgets_values"][-1] == "strict"
        tagged_refs = [item for item in workflow["nodes"]
                       if item.get("type") ==
                       "MiniMaxH3TaggedPictureReference"]
        assert len(tagged_refs) == 2
        assert {tuple(item["widgets_values"]) for item in tagged_refs} == {
            ("style_base",), ("interior",)}
        assert not any(item.get("type", "").startswith(
            "MiniMaxH3Scheduled") for item in workflow["nodes"])
        base = next(item for item in tagged_refs
                    if item["widgets_values"][0] == "style_base")
        interior = next(item for item in tagged_refs
                        if item["widgets_values"][0] == "interior")
        assert socket(base["inputs"], "image")["link"] is not None
        assert socket(base["inputs"], "previous")["link"] is None
        assert socket(interior["inputs"], "image")["link"] is not None
        assert socket(interior["inputs"], "previous")["link"] is not None
        assert socket(conditioner["inputs"],
                      "references")["link"] is not None
        current = node(workflow, "MiniMaxH3ChainCurrent")
        assert socket(current["outputs"], "clip_index")["links"] == [
            socket(conditioner["inputs"], "clip_index")["link"]]
        assert socket(current["outputs"], "clip_count")["links"] == [
            socket(conditioner["inputs"], "clip_count")["link"]]
        assert socket(plan_node["inputs"],
                      "generation_fingerprint")["link"] is not None
        prompts = [prompt_text(shot["prompt"]) for shot in plan["shots"]]
        assert "@style_base" in prompts[0] and "@interior" not in prompts[0]
        assert "@style_base" in prompts[1] and "@interior" in prompts[1]
        assert all("<Picture" not in prompt for prompt in prompts)

        if variant == "tagged":
            assert "MiniMaxH3ChainRunManager" not in node_types
            editor = node(workflow, "MiniMaxH3ChainScenePromptEditor")
            assert socket(editor["inputs"], "plan")["link"] is not None
        else:
            studio = node(workflow, "MiniMaxH3ChainPlanStudio")
            rich = node(workflow, "MiniMaxH3ChainRichScenePromptEditor")
            manager = node(workflow, "MiniMaxH3ChainRunManager")
            loop_start = node(workflow, "MiniMaxH3ChainLoopStart")
            assert socket(studio["inputs"], "plan")["link"] is not None
            assert socket(rich["inputs"], "plan")["link"] is not None
            assert socket(manager["inputs"], "plan")["link"] is not None
            assert socket(rich["outputs"], "plan")["links"] == [
                socket(manager["inputs"], "plan")["link"]]
            assert socket(loop_start["inputs"], "plan")["link"] == (
                socket(manager["outputs"], "plan")["links"][0])
            assert socket(manager["inputs"], "asset_0")["link"] is not None
            assert socket(manager["inputs"], "asset_1")["link"] is not None
            assert manager["widgets_values"][0:3] == [True, True, False]
            if variant == "studio":
                assert plan_node["widgets_values"][-1] == "masked_av"
                context = node(workflow, "MiniMaxH3ChainContext")
                sampler = node(workflow, "SamplerCustomAdvanced")
                assert socket(context["outputs"], "latent")["links"] == [
                    socket(sampler["inputs"], "latent_image")["link"]]
            bindings = json.loads(manager["widgets_values"][3])
            assert len(bindings) == (3 if variant == "source_audio" else 2)
            assert {item["original_value"] for item in bindings} == {
                "jigen_market_garden_doom_opening.png",
                "jigen_market_garden_doom_last.png",
                *({"SELECT_FULL_SOURCE_TRACK.wav"}
                  if variant == "source_audio" else set()),
            }
            expected_roles = (
                {"picture", "source_track"}
                if variant == "source_audio" else {"picture"})
            assert {item["role"] for item in bindings} == expected_roles
            assert all(loader.get("properties", {}).get(
                "h3_asset_binding_ids", {}).get("0")
                for loader in loaders)

    assert conditioner["widgets_values"][1:4] == [896, 672, 243]
    assert socket(conditioner["inputs"], "audio_vae")["link"] is not None
    notes = "\n".join(
        str(item.get("widgets_values", [""])[0])
        for item in workflow["nodes"] if item.get("type") == "Note")
    assert "ᴊɪɢᴇɴ" in notes and I2V_SOURCE_URL in notes
    assert "subject_definitions:" in notes and "non_diegetic_music:" in notes
    return workflow, plan


def validate_ref2v_source_audio(path):
    workflow, plan = validate_ref2v(path, "source_audio")
    audio_loader = node(workflow, "LoadAudio")
    audio_ref = node(workflow, "MiniMaxH3TaggedAudioReference")
    conditioner = node(workflow, "MiniMaxH3TaggedReferenceToVideo")
    plan_node = node(workflow, "MiniMaxH3ChainPlan")
    current = node(workflow, "MiniMaxH3ChainCurrent")
    loop_start = node(workflow, "MiniMaxH3ChainLoopStart")
    manifest_load = node(workflow, "MiniMaxH3ChainManifestLoad")
    manager = node(workflow, "MiniMaxH3ChainRunManager")
    assembles = [item for item in workflow["nodes"]
                 if item.get("type") == "MiniMaxH3ChainAssemble"]
    assert len(assembles) == 2

    assert audio_loader["widgets_values"][0] == "SELECT_FULL_SOURCE_TRACK.wav"
    assert audio_ref["widgets_values"] == [
        "audio_1", "source_timeline", True]
    assert socket(audio_ref["inputs"], "audio")["link"] is not None
    assert socket(audio_ref["inputs"], "previous")["link"] is not None
    assert socket(conditioner["inputs"], "references")["link"] == (
        socket(audio_ref["outputs"], "references")["links"][0])
    assert socket(conditioner["inputs"], "state")["link"] in (
        socket(current["outputs"], "state")["links"])
    assert socket(plan_node["inputs"], "generation_fingerprint")["link"] == (
        socket(audio_ref["outputs"], "reference_fingerprint")["links"][0])

    source_consumers = [loop_start, current, manifest_load, *assembles]
    source_links = {
        socket(item["inputs"], "source_audio")["link"]
        for item in source_consumers
    }
    source_links.add(socket(audio_ref["inputs"], "audio")["link"])
    source_links.add(socket(manager["inputs"], "asset_2")["link"])
    assert None not in source_links
    assert source_links == set(socket(
        audio_loader["outputs"], "AUDIO")["links"])
    assert audio_loader["properties"]["h3_asset_binding_ids"]["0"] == (
        "ref2v-source-audio-v1")
    assert manager["properties"]["h3_asset_roles"][
        "ref2v-source-audio-v1"] == "source_track"
    assert all("@audio_1" in prompt_text(shot["prompt"])
               for shot in plan["shots"])
    return workflow, plan


def validate_sequential_motion_ref(path):
    workflow = load(path)
    validate_links(workflow)
    assert path.name.startswith("EXPERIMENTAL ")
    assert node(workflow, "UNETLoader")["widgets_values"][0] == (
        "MiniMax-H3/minimax_h3_ref2va_pruned_int8_convrot.safetensors")

    loader = node(workflow, "LoadVideo")
    prep = node(workflow, "MiniMaxH3ReferenceVideoPrepare")
    motion = node(workflow, "MiniMaxH3TaggedVideoReference")
    wrapper = node(workflow, "MiniMaxH3TaggedReferenceToVideo")
    current = node(workflow, "MiniMaxH3ChainCurrent")
    priority = node(workflow, "MiniMaxH3PatchPriority")
    context = node(workflow, "MiniMaxH3ChainContext")
    plan_node = node(workflow, "MiniMaxH3ChainPlan")
    plan = json.loads(plan_node["widgets_values"][0])

    assert loader["widgets_values"][0] == (
        "SELECT_LONG_MOTION_REFERENCE_WITH_AUDIO.mp4")
    assert prep["widgets_values"] == [464, 24]
    assert socket(prep["inputs"], "source_video")["link"] == (
        socket(loader["outputs"], "VIDEO")["links"][0])
    assert socket(motion["inputs"], "video")["link"] == (
        socket(prep["outputs"], "ref_video")["links"][0])
    assert socket(motion["inputs"], "audio")["link"] == (
        socket(prep["outputs"], "source_audio")["links"][0])
    assert motion["widgets_values"] == [
        "motion", "motion_audio", "sequential"]
    assert socket(motion["inputs"], "previous")["link"] is not None
    assert socket(wrapper["inputs"], "references")["link"] == (
        socket(motion["outputs"], "references")["links"][0])
    assert socket(wrapper["inputs"], "state")["link"] == (
        socket(current["outputs"], "state")["links"][-1])
    assert socket(wrapper["inputs"], "clip_index")["link"] is not None
    assert socket(wrapper["inputs"], "clip_count")["link"] is not None
    assert socket(plan_node["inputs"], "generation_fingerprint")["link"] == (
        socket(motion["outputs"], "reference_fingerprint")["links"][0])

    assert socket(priority["inputs"], "conditioning")["link"] == (
        socket(wrapper["outputs"], "positive")["links"][0])
    assert socket(context["inputs"], "conditioning")["link"] == (
        socket(priority["outputs"], "conditioning")["links"][0])

    assert [shot["length"] for shot in plan["shots"]] == [243, 243]
    assert plan_node["widgets_values"][5] == 22
    assert plan_node["widgets_values"][9] == "generated_audio"
    prompts = ["\n".join(shot["prompt"]) for shot in plan["shots"]]
    for prompt in prompts:
        assert "@motion" in prompt and "@motion_audio" in prompt
        positions = [prompt.index(section) for section in (
            "subject_definitions:", "summary:", "retention_analysis:",
            "detailed_description:", "overall_soundscape:",
            "non_diegetic_music:")]
        assert positions == sorted(positions) and positions[0] == 0
    assert "source frame 0" in prompts[0]
    assert "source frame 221" in prompts[1]
    notes = "\n".join(
        str(item.get("widgets_values", [""])[0])
        for item in workflow["nodes"] if item.get("type") == "Note")
    assert "EXPERIMENTAL" in notes
    assert "0:243" in notes and "221:464" in notes
    assert "19.333" in notes and "embedded audio" in notes
    return workflow, plan


def validate_deferred_h3_upscale(path):
    workflow = load(path)
    validate_links(workflow)
    node_types = {item.get("type") for item in workflow["nodes"]}
    required = {
        "MiniMaxH3ChainCheckpointManager",
        "MiniMaxH3ChainUpscaleAdapter",
        "MiniMaxH3ChainUpscaleCurrent",
        "MiniMaxH3LatentUpscaleCombined",
        "MiniMaxH3Pass2StaggeredScheduler",
        "SamplerCustomAdvanced",
        "MiniMaxH3ChainUpscaleSegmentSave",
        "MiniMaxH3ChainUpscaleLoopEnd",
        "MiniMaxH3ChainUpscaleMerge",
    }
    assert required <= node_types
    assert "MiniMaxH3ChainLoopStart" not in node_types
    assert "MiniMaxH3ChainContext" not in node_types

    manager = node(workflow, "MiniMaxH3ChainCheckpointManager")
    adapter = node(workflow, "MiniMaxH3ChainUpscaleAdapter")
    current = node(workflow, "MiniMaxH3ChainUpscaleCurrent")
    combined = node(workflow, "MiniMaxH3LatentUpscaleCombined")
    scheduler = node(workflow, "MiniMaxH3Pass2StaggeredScheduler")
    sampler = node(workflow, "SamplerCustomAdvanced")
    saver = node(workflow, "MiniMaxH3ChainUpscaleSegmentSave")
    loop_end = node(workflow, "MiniMaxH3ChainUpscaleLoopEnd")
    merger = node(workflow, "MiniMaxH3ChainUpscaleMerge")

    assert socket(manager["outputs"], "plan")["links"] == [
        socket(adapter["inputs"], "plan")["link"]]
    assert adapter["widgets_values"][0:2] == ["h3_learned_2x", "h3_latent"]
    assert adapter["widgets_values"][3:7] == [1, 0, False, 18]
    assert socket(adapter["outputs"], "flow")["links"] == [
        socket(loop_end["inputs"], "flow")["link"]]
    assert socket(current["outputs"], "source_latent")["links"] == [
        socket(combined["inputs"], "samples")["link"]]
    for output_name, input_name in (
            ("prompt", "prompt"), ("width", "width"),
            ("height", "height"), ("raw_frames", "length")):
        conditioner = node(workflow, "MiniMaxH3ImageToVideo")
        assert socket(current["outputs"], output_name)["links"] == [
            socket(conditioner["inputs"], input_name)["link"]]
    assert scheduler["widgets_values"] == [
        4, 0.45, 7.0, "karras", 8, "normal"]
    assert combined["widgets_values"][0] == "learned model"
    assert combined["widgets_values"][2:] == [0.0, "independent", 0.0]
    guider = node(workflow, "BasicGuider")
    assert socket(combined["outputs"], "positive")["links"] == [
        socket(guider["inputs"], "conditioning")["link"]]
    assert node(workflow, "KSamplerSelect")["widgets_values"] == ["euler"]
    assert socket(sampler["outputs"], "output")["links"]
    assert socket(saver["inputs"], "images")["link"] is not None
    assert socket(saver["inputs"], "upscaled_latent")["link"] is not None
    assert socket(loop_end["inputs"], "images")["link"] is not None
    assert socket(loop_end["inputs"], "upscaled_latent")["link"] is not None
    assert socket(loop_end["outputs"], "manifest")["links"] == [
        socket(merger["inputs"], "manifest")["link"]]
    notes = "\n".join(
        str(item.get("widgets_values", [""])[0])
        for item in workflow["nodes"] if item.get("type") == "Note")
    assert "Load selected branch" in notes
    assert "save_latent is OFF" in notes
    assert "ComfyUI-MiniMaxH3_LatentUpscaler" in notes
    return workflow


def main():
    assert EXAMPLES.joinpath("README.md").is_file()
    assert ARCHIVE.joinpath("README.md").is_file()
    assert len(list(ARCHIVE.glob("*.json"))) == 9
    for path in ARCHIVE.glob("*.json"):
        validate_links(load(path))

    t2v_normal_path = EXAMPLES / "MiniMax H3 T2V - Normal.json"
    t2v_studio_path = EXAMPLES / "MiniMax H3 T2V - Studio.json"
    i2v_normal_path = EXAMPLES / "MiniMax H3 I2V - Normal.json"
    i2v_studio_path = EXAMPLES / "MiniMax H3 I2V - Studio.json"
    fl2v_normal_path = EXAMPLES / "MiniMax H3 FL2V - Normal.json"
    ref2v_basic_path = EXAMPLES / "MiniMax H3 Ref2V - Basic.json"
    ref2v_tagged_path = EXAMPLES / "MiniMax H3 Ref2V - Tagged.json"
    ref2v_studio_path = EXAMPLES / "MiniMax H3 Ref2V - Studio Tagged.json"
    ref2v_source_audio_path = (
        EXAMPLES / "MiniMax H3 Ref2V - Studio Tagged Source Audio.json")
    sequential_path = (
        EXAMPLES / "EXPERIMENTAL MiniMax H3 Ref2V - Sequential Motion.json")
    deferred_upscale_path = (
        EXAMPLES / "MiniMax H3 Deferred Upscale - H3 Learned 2x.json")
    assert set(path.name for path in EXAMPLES.glob("*.json")) == {
        t2v_normal_path.name, t2v_studio_path.name,
        i2v_normal_path.name, i2v_studio_path.name,
        fl2v_normal_path.name, ref2v_basic_path.name,
        ref2v_tagged_path.name, ref2v_studio_path.name,
        ref2v_source_audio_path.name,
        sequential_path.name,
        deferred_upscale_path.name,
    }
    for path in EXAMPLES.glob("*.json"):
        workflow = load(path)
        if path == deferred_upscale_path:
            continue
        context = node(workflow, "MiniMaxH3ChainContext")
        sampler = node(workflow, "SamplerCustomAdvanced")
        assert socket(context["outputs"], "latent")["links"] == [
            socket(sampler["inputs"], "latent_image")["link"]], path.name
    t2v_normal, t2v_normal_plan = validate_t2v(
        t2v_normal_path, "MiniMaxH3ChainScenePromptEditor", 0)
    t2v_studio, t2v_studio_plan = validate_t2v(
        t2v_studio_path, "MiniMaxH3ChainPlanStudio", 5)
    assert t2v_normal_plan == t2v_studio_plan
    i2v_normal, i2v_normal_plan = validate_i2v(
        i2v_normal_path, "MiniMaxH3ChainScenePromptEditor", 0)
    i2v_studio, i2v_studio_plan = validate_i2v(
        i2v_studio_path, "MiniMaxH3ChainPlanStudio", 5)
    assert i2v_normal_plan == i2v_studio_plan
    fl2v_normal, _fl2v_normal_plan = validate_fl2v(fl2v_normal_path)
    ref2v_basic, _ref2v_basic_plan = validate_ref2v(
        ref2v_basic_path, "basic")
    ref2v_tagged, ref2v_tagged_plan = validate_ref2v(
        ref2v_tagged_path, "tagged")
    ref2v_studio, ref2v_studio_plan = validate_ref2v(
        ref2v_studio_path, "studio")
    ref2v_source_audio, ref2v_source_audio_plan = (
        validate_ref2v_source_audio(ref2v_source_audio_path))
    assert comparable_plan(ref2v_tagged_plan) == comparable_plan(
        ref2v_studio_plan)
    assert [
        (shot["id"], shot["length"], shot["steps"], shot["seed"])
        for shot in ref2v_studio_plan["shots"]
    ] == [
        (shot["id"], shot["length"], shot["steps"], shot["seed"])
        for shot in ref2v_source_audio_plan["shots"]
    ]
    sequential, _sequential_plan = validate_sequential_motion_ref(
        sequential_path)
    deferred_upscale = validate_deferred_h3_upscale(deferred_upscale_path)

    def generation_types(workflow):
        return collections.Counter(
            item.get("type")
            for item in workflow["nodes"]
            if item.get("type") not in {
                "MiniMaxH3ChainScenePromptEditor",
                "MiniMaxH3ChainPlanStudio",
                "MiniMaxH3ChainRichScenePromptEditor",
                "MiniMaxH3ChainRunManager",
            })

    assert generation_types(t2v_normal) == generation_types(t2v_studio)
    assert generation_types(i2v_normal) == generation_types(i2v_studio)
    assert generation_types(ref2v_tagged) == generation_types(ref2v_studio)
    uuids = {
        workflow["extra"]["comfyui_mcp"]["workflow_uuid"]
        for workflow in (
            t2v_normal, t2v_studio, i2v_normal, i2v_studio, fl2v_normal,
            ref2v_basic, ref2v_tagged, ref2v_studio, ref2v_source_audio,
            sequential, deferred_upscale)
    }
    assert len(uuids) == 11

    asset = EXAMPLES / "assets" / "jigen_market_garden_doom_opening.png"
    assert asset.is_file()
    assert hashlib.sha256(asset.read_bytes()).hexdigest() == I2V_ASSET_SHA256
    last_asset = EXAMPLES / "assets" / "jigen_market_garden_doom_last.png"
    assert last_asset.is_file()
    assert hashlib.sha256(last_asset.read_bytes()).hexdigest() == (
        FL2V_LAST_ASSET_SHA256)

    print("H3 workflow catalog: T2VA, I2VA, indexed A-B-A FL2VA, Basic / "
          "Tagged / Studio Tagged / source-timeline audio Ref2VA, and "
          "experimental sequential motion Ref2VA, and deferred learned H3 2x; "
          "valid links, bundled "
          "assets, timeline wiring, six-section prompts, restoration, and "
          "attribution pass")


if __name__ == "__main__":
    main()
