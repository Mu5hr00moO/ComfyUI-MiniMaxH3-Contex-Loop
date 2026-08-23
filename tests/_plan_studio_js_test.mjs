#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import {
    locateStudioTimelineSecond,
    h3StudioGridMarkers,
    matchingStudioCheckpoint,
    matchingStudioSourceScene,
    studioCheckpointSignature,
    studioSceneStartSeconds,
    studioSourceSecond,
} from "../web/h3_chain_plan_studio_core.mjs";
import {
    applySceneTransitionPreset,
    sceneTransitionPreset,
} from "../web/h3_policy_core.mjs";

const studioBoundary = {};
assert.equal(sceneTransitionPreset(studioBoundary), "inherit");
applySceneTransitionPreset(studioBoundary, "soft_av");
assert.deepEqual(studioBoundary, {
    continuation_mode: "audio_feathered_av", context_length: 39,
    audio_context_length: 39,
});

const rows = [
    {id:"one", deliveredFrames:362, deliveredSeconds:362 / 24},
    {id:"two", deliveredFrames:340, deliveredSeconds:340 / 24},
    {id:"three", deliveredFrames:340, deliveredSeconds:340 / 24},
];
assert.equal(studioSceneStartSeconds(rows, 1), 362 / 24);
assert.equal(locateStudioTimelineSecond(rows, 0).index, 0);
assert.equal(locateStudioTimelineSecond(rows, 362 / 24).index, 1);
assert.equal(locateStudioTimelineSecond(rows, 999).index, 2);
assert.ok(Math.abs(
    locateStudioTimelineSecond(rows, 362 / 24 + 1).localSeconds - 1,
) < 1e-9);

const checkpoints = new Map([[1, {
    scene:1, scene_id:"one", ready:true, delivered_frames:362,
    video:{filename:"one.mp4"}, audio:{filename:"one.wav"},
}]]);
assert.equal(matchingStudioCheckpoint(checkpoints, 0, rows[0]).scene_id, "one");
assert.equal(matchingStudioCheckpoint(checkpoints, 0, {...rows[0], id:"renamed"}), null);
assert.equal(matchingStudioCheckpoint(checkpoints, 0, {...rows[0], deliveredFrames:340}), null);
assert.notEqual(
    studioCheckpointSignature("run-a", [...checkpoints.values()]),
    studioCheckpointSignature("run-b", [...checkpoints.values()]),
);
assert.notEqual(
    studioCheckpointSignature("run-a", [...checkpoints.values()]),
    studioCheckpointSignature("run-a", [{
        ...checkpoints.get(1), audio:{filename:"changed.wav"},
    }]),
);

const sourceTimeline = {token:"opaque", scenes:[{
    scene:2, scene_id:"two", delivered_frames:340,
    references:[{frame_count:362, compare_offset_frames:22}],
}]};
assert.equal(
    matchingStudioSourceScene(sourceTimeline, 1, rows[1]).scene_id, "two",
);
assert.equal(matchingStudioSourceScene(sourceTimeline, 0, rows[0]), null);
assert.equal(
    matchingStudioSourceScene(sourceTimeline, 1, {...rows[1], deliveredFrames:339}),
    null,
);
assert.ok(Math.abs(studioSourceSecond(
    sourceTimeline.scenes[0].references[0], 1,
) - (22 / 24 + 1)) < 1e-9);

const exactGrid = h3StudioGridMarkers(345, 39, "masked_av");
assert.deepEqual(exactGrid.raw, {
    frames:345, onGrid:true, index:20, label:"345f = 17×20+5",
});
assert.equal(exactGrid.av.exact, true);
assert.equal(exactGrid.av.audioTicks, 65);
assert.deepEqual(exactGrid.cut, {
    start:337, end:340, experimental:true, label:"cut test 337–340f",
});
const fractionalGrid = h3StudioGridMarkers(362, 22, "feathered_av");
assert.equal(fractionalGrid.raw.onGrid, true);
assert.equal(fractionalGrid.av.exact, false);
assert.equal(fractionalGrid.av.label, "22f AV = 36.667 audio ticks");
const audioFeatherGrid = h3StudioGridMarkers(345, 39, "audio_feathered_av");
assert.equal(audioFeatherGrid.av.exact, true);
assert.equal(audioFeatherGrid.av.audioTicks, 65);
const detailAvGrid = h3StudioGridMarkers(345, 39, "tapered_av");
assert.equal(detailAvGrid.av.exact, true);
assert.equal(detailAvGrid.av.audioTicks, 65);
const driftAvGrid = h3StudioGridMarkers(345, 39, "drift_control_av");
assert.equal(driftAvGrid.av.exact, true);
assert.equal(driftAvGrid.av.audioTicks, 65);
assert.equal(h3StudioGridMarkers(344, 39, "guide").raw.onGrid, false);
assert.equal(h3StudioGridMarkers(344, 39, "guide").av, null);

const source = fs.readFileSync(
    new URL("../web/h3_chain_plan_studio.js", import.meta.url),
    "utf8",
);

assert.match(source, /MiniMaxH3ChainPlanStudio/);
assert.match(source, /MiniMaxH3ChainPlan/);
assert.match(source, /item\.name === name/);
assert.match(source, /state\.planWidget\.value = value/);
assert.match(source, /h3studio-timeline/);
assert.match(source, /Scene prompt/);
assert.match(source, /Shared prompt/);
assert.match(source, /Generated ↔ motion-reference comparison/);
assert.match(source, /MOTION REF/);
assert.match(source, /plan-studio\/source-preview/);
assert.match(source, /h3_plan_studio_source_timeline/);
assert.match(source, /\/minimax_h3_context_loop\/checkpoints/);
assert.match(source, /include_graph:"false"/);
assert.match(source, /state\.checkpointPromise/);
assert.match(source, /state\.checkpointRefreshQueued/);
assert.match(source, /\/minimax_h3_context_loop\/prompt-history/);
assert.match(source, /promptRevisionNavigation/);
assert.match(source, /availableReferenceRecords/);
assert.match(source, /state\.planNode \?\? node/);
assert.match(source, /preview_video/);
assert.match(source, /item\.preview_video \? null : \(item\.audio \?\? null\)/);
assert.match(source, /playerAudio/);
assert.match(source, /synchronizeGeneratedAudio/);
assert.match(source, /delivered-audio sidecar/);
assert.match(source, /currentSettings === state\.lastSettingsSignature/);
assert.match(source, /state\.timelinePosition = target/);
assert.match(source, /state\.view !== "player"/);
assert.match(source, /renderSourceTimeline\(\); updateTimelineSelection\(\)/);
assert.match(source, /h3_chain_active_scene/);
assert.match(source, /api\.removeEventListener\("executed", onPromptExecuted\)/);
assert.match(source, /renderShell\(\)/);
assert.match(source, /serialize:false/);
assert.match(source, /connectedPromptEditors/);
assert.match(source, /Prompt editing delegated to/);
assert.match(source, /preserveDelegatedPrompts\(\)/);
assert.match(source, /publishCompanionScene/);
assert.match(source, /Append a new scene and select it/);
assert.match(source, /state\.plan\.shots\.push\(makeShot\(state\.plan\.shots\)\)/);
assert.match(source, /state\.active = state\.plan\.shots\.length - 1/);
assert.match(source, /field\("Incoming transition", incomingTransition\)/);
assert.match(source, /field\("Final assembly crossfade frames", blendFrames\)/);
assert.match(source, /Advanced boundary controls/);
assert.match(source, /experimentalCutMarker\.hidden = !advanced\.open/);
assert.match(source, /advanced\.addEventListener\("toggle", refreshExperimentalMarkers\)/);
assert.match(source, /field\("Implementation", continuation\)/);
assert.match(source, /applySceneTransitionPreset/);
assert.match(source, /field\("Boundary spatial proxy", spatialProxy\)/);
assert.match(source, /Low-grid 5\/6 proxy · Guide/);
assert.match(source, /Latent 5\/6 proxy · AV/);
assert.match(source, /context_spatial_proxy/);
assert.match(source, /field\("Visual \/ audio context", contextPair\)/);
assert.match(source, /audio_context_length/);
assert.match(source, /video_blend_frames/);
assert.match(source, /Guide · new shot/);
assert.match(source, /Latent Guide · direct generated latent/);
assert.match(source, /Raw Guide · protected sampled prefix/);
assert.match(source, /Detail Guide · color injection/);
assert.match(source, /Masked AV · same shot/);
assert.match(source, /Feathered AV · experimental dual-stream feather/);
assert.doesNotMatch(source, /Feathered AV \+ RGB/);
assert.match(source, /17n\+5 temporal latent grid/);
assert.match(source, /Exact aligned choices are 39, 90, 141, 192/);
assert.match(source, /Experimental only: nearest reported four-frame 17n−3 cut window/);

console.log("H3 Plan Studio: separate timeline editor contract passes");
