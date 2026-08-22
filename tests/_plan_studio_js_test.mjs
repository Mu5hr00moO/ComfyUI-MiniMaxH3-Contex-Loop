#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import {
    locateStudioTimelineSecond,
    matchingStudioCheckpoint,
    studioCheckpointSignature,
    studioSceneStartSeconds,
} from "../web/h3_chain_plan_studio_core.mjs";

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
assert.match(source, /Playback uses synchronized Review previews/);
assert.match(source, /\/minimax_h3_context_loop\/checkpoints/);
assert.match(source, /\/minimax_h3_context_loop\/prompt-history/);
assert.match(source, /promptRevisionNavigation/);
assert.match(source, /availableReferenceRecords/);
assert.match(source, /state\.planNode \?\? node/);
assert.match(source, /preview_video/);
assert.match(source, /item\.preview_video \? null : \(item\.audio \?\? null\)/);
assert.match(source, /playerAudio/);
assert.match(source, /synchronizeAudio/);
assert.match(source, /delivered-audio sidecar/);
assert.match(source, /currentSettings === state\.lastSettingsSignature/);
assert.match(source, /state\.timelinePosition = target/);
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
assert.match(source, /field\("Continuation", continuation\)/);
assert.match(source, /field\("Context V \/ A", contextPair\)/);
assert.match(source, /audio_context_length/);
assert.match(source, /Guide · new shot/);
assert.match(source, /Latent Guide · raw latent/);
assert.match(source, /Masked AV · same shot/);
assert.match(source, /masked decoded-frame VAE fallback/);

console.log("H3 Plan Studio: separate timeline editor contract passes");
