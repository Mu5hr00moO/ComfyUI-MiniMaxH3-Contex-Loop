#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import {
    AUTO_SCENE_COLORS,
    CONTINUATION_MODES,
    H3_CONTEXT_LENGTHS,
    automaticSceneColor,
    calculatePlanTiming,
    derivedSceneSeed,
    duplicateShot,
    h3FrameLength,
    moveShot,
    parsePlanJson,
    planToJson,
    promptValueToText,
    randomSceneSeed,
    sceneAudioContextLength,
    sceneContextLength,
    sceneContinuationMode,
    setShotLengthMode,
    setSharedPrompt,
    shotLengthMode,
    sharedPrompt,
    validateH3Length,
} from "../web/h3_chain_plan_core.mjs";

assert.equal(AUTO_SCENE_COLORS.length, 12);
assert.deepEqual(CONTINUATION_MODES, ["guide", "latent_guide", "masked_av"]);
assert.equal(H3_CONTEXT_LENGTHS.at(-1), 243);
assert.equal(new Set(AUTO_SCENE_COLORS).size, AUTO_SCENE_COLORS.length);
assert.equal(automaticSceneColor(0), AUTO_SCENE_COLORS[0]);
assert.equal(automaticSceneColor(12), AUTO_SCENE_COLORS[0]);
assert.equal(automaticSceneColor(-1), AUTO_SCENE_COLORS.at(-1));
assert.equal(await derivedSceneSeed(0, 1, "intro"), "2670204060324819354");
assert.equal(await derivedSceneSeed(42, 2, "scene_02"), "7780599706863635211");
assert.equal(
    await derivedSceneSeed(42, 2, "scene_02", {}),
    "7780599706863635211",
);
assert.equal(randomSceneSeed({
    getRandomValues(words) {
        words[0] = 0x12345678;
        words[1] = 0x9abcdef0;
        return words;
    },
}), "1311768467463790320");

const exactLengthShot = {length: 209};
assert.equal(shotLengthMode(exactLengthShot), "frames");
setShotLengthMode(exactLengthShot, "seconds", 15);
assert.equal(shotLengthMode(exactLengthShot), "seconds");
assert.equal(exactLengthShot.duration_seconds, 209 / 24);
assert.equal(exactLengthShot.length, undefined);
setShotLengthMode(exactLengthShot, "frames", 15);
assert.deepEqual(exactLengthShot, {length: 209});

const requestedSecondsShot = {duration_seconds: 10};
setShotLengthMode(requestedSecondsShot, "frames", 15);
assert.deepEqual(requestedSecondsShot, {length: 243});
setShotLengthMode(requestedSecondsShot, "seconds", 15);
assert.deepEqual(requestedSecondsShot, {duration_seconds: 243 / 24});

const inheritedLengthShot = {};
setShotLengthMode(inheritedLengthShot, "frames", 15);
assert.deepEqual(inheritedLengthShot, {length: 362});
setShotLengthMode(inheritedLengthShot, "default", 15);
assert.deepEqual(inheritedLengthShot, {});

assert.equal(sceneContinuationMode({}, "guide"), "guide");
assert.equal(
    sceneContinuationMode({continuation_mode: "masked_av"}, "guide"),
    "masked_av",
);
assert.equal(
    sceneContinuationMode({continuation_mode: "latent_guide"}, "guide"),
    "latent_guide",
);
assert.throws(
    () => sceneContinuationMode({continuation_mode: "unknown"}, "guide"),
    /Unknown scene continuation mode/,
);
assert.equal(sceneContextLength({}, 22), 22);
assert.equal(sceneContextLength({context_length: ""}, 22), 22);
assert.equal(sceneContextLength({context_length: 0}, 22), 0);
assert.equal(sceneContextLength({context_length: 39}, 22), 39);
assert.throws(() => sceneContextLength({context_length: 2}, 22), /must be 0/);
assert.equal(sceneAudioContextLength({}, 22, 0), 22);
assert.equal(sceneAudioContextLength({}, 0, 39), 39);
assert.equal(sceneAudioContextLength({audio_context_length: 0}, 22, 39), 0);
assert.equal(sceneAudioContextLength({audio_context_length: 33}, 22, 0), 33);
assert.throws(
    () => sceneAudioContextLength({audio_context_length: 241}, 22, 0),
    /between 0 and 240/,
);

const invalidDurationShot = {duration_seconds: 999};
assert.throws(() => setShotLengthMode(invalidDurationShot, "frames", 15));
assert.deepEqual(invalidDurationShot, {duration_seconds: 999});

const plan = parsePlanJson(JSON.stringify({
    prompt_prefix: ["Identity.", "", "Wardrobe."],
    defaults: {duration_seconds: 15, steps: 20},
    shots: [
        {id: "one", prompt: "Opening.\nKeep moving.", seed: 18446744073709551615n.toString()},
        {id: "two", prompt: ["Continue.", "", "End turning."], length: 260},
    ],
}));

assert.equal(sharedPrompt(plan).text, "Identity.\n\nWardrobe.");
assert.equal(promptValueToText(plan.shots[0].prompt), "Opening.\nKeep moving.");
setSharedPrompt(plan, "New identity.\n\nNew wardrobe.");
assert.deepEqual(plan.prompt_prefix, ["New identity.", "", "New wardrobe."]);
assert.equal(JSON.parse(planToJson(plan)).shots[0].seed, "18446744073709551615");

const numericSeed = parsePlanJson(
    '{"shots":[{"id":"seed","prompt":"x","seed":18446744073709551615}]}',
);
assert.equal(numericSeed.shots[0].seed, "18446744073709551615");
const promptContainingSeedText = parsePlanJson(
    '{"shots":[{"prompt":"Literal \\\"seed\\\": 18446744073709551615 text"}]}',
);
assert.equal(
    promptValueToText(promptContainingSeedText.shots[0].prompt),
    'Literal "seed": 18446744073709551615 text',
);

const shorthandDefaults = parsePlanJson(JSON.stringify({
    duration_seconds: 8,
    steps: 10,
    shots: [{
        id: "imported",
        prompt: "Imported prompt.",
        duration_seconds: 6,
        steps: 12,
    }],
}));
assert.deepEqual(shorthandDefaults.defaults, {duration_seconds: 8, steps: 10});
assert.equal(Object.hasOwn(shorthandDefaults, "duration_seconds"), false);
assert.equal(Object.hasOwn(shorthandDefaults, "steps"), false);
assert.equal(shorthandDefaults.shots[0].duration_seconds, 6);
assert.equal(shorthandDefaults.shots[0].steps, 12);

assert.equal(h3FrameLength(5), 124);
assert.equal(h3FrameLength(10), 243);
assert.equal(h3FrameLength(15), 362);
assert.equal(validateH3Length(260), 260);
assert.throws(() => validateH3Length(240), /length % 17/);

const timing = calculatePlanTiming(plan, {
    contextLength: 22,
    encodeMode: "video",
    anchorMode: "head",
    continuationMode: "guide",
    defaultDurationSeconds: 5,
    defaultSteps: 10,
});
assert.deepEqual(timing.shots.map((shot) => shot.rawFrames), [362, 260]);
assert.deepEqual(timing.shots.map((shot) => shot.deliveredFrames), [362, 238]);
assert.equal(timing.shots[1].generationStartFrame, 340);
assert.equal(timing.totalFrames, 600);
assert.deepEqual(timing.errors, []);
assert.deepEqual(
    timing.shots.map((shot) => shot.continuationMode),
    ["guide", "guide"],
);

const mixedContinuationPlan = parsePlanJson(JSON.stringify({
    shots: [
        {id: "new_shot", prompt: "Flexible transition."},
        {id: "same_shot", prompt: "Exact continuation.", continuation_mode: "masked_av"},
    ],
}));
const mixedContinuationTiming = calculatePlanTiming(mixedContinuationPlan, {
    contextLength: 39,
    encodeMode: "video",
    anchorMode: "head",
    continuationMode: "guide",
    defaultDurationSeconds: 5,
});
assert.deepEqual(
    mixedContinuationTiming.shots.map((shot) => shot.continuationMode),
    ["guide", "masked_av"],
);
assert.deepEqual(mixedContinuationTiming.errors, []);
assert.equal(
    JSON.parse(planToJson(mixedContinuationPlan)).shots[1].continuation_mode,
    "masked_av",
);
assert.match(calculatePlanTiming(mixedContinuationPlan, {
    contextLength: 1,
    encodeMode: "frames",
    anchorMode: "before",
    continuationMode: "guide",
    defaultDurationSeconds: 5,
}).errors.join("\n"), /Masked AV requires/);

const mixedContextTiming = calculatePlanTiming({shots: [
    {id: "one", prompt: "One.", length: 192},
    {id: "clean", prompt: "Clean.", length: 192, context_length: 0,
        continuation_mode: "masked_av"},
    {id: "continued", prompt: "Continue.", length: 192, context_length: 39},
]}, {
    contextLength: 22,
    encodeMode: "frames",
    anchorMode: "before",
    continuationMode: "guide",
});
assert.deepEqual(
    mixedContextTiming.shots.map((shot) => shot.contextLength), [22, 0, 39],
);
assert.deepEqual(
    mixedContextTiming.shots.map((shot) => shot.deliveredFrames), [192, 192, 192],
);
assert.deepEqual(mixedContextTiming.errors, []);

const audioOnlyTiming = calculatePlanTiming({shots: [
    {id: "one", prompt: "One.", length: 192},
    {id: "audio_only", prompt: "New picture, continuous sound.", length: 192,
        context_length: 0, audio_context_length: 33},
]}, {
    contextLength: 22,
    audioContextLength: 22,
    encodeMode: "video",
    anchorMode: "head",
    continuationMode: "guide",
});
assert.equal(audioOnlyTiming.shots[1].contextLength, 0);
assert.equal(audioOnlyTiming.shots[1].audioContextLength, 33);
assert.equal(audioOnlyTiming.shots[1].deliveredFrames, 192);
assert.deepEqual(audioOnlyTiming.errors, []);

const sharedOnlyPlan = parsePlanJson(JSON.stringify({
    prompt_prefix: "Shared identity and direction.",
    shots: [{id: "shared_only", prompt: ""}],
}));
const sharedOnlyTiming = calculatePlanTiming(sharedOnlyPlan, {
    contextLength: 22,
    anchorMode: "head",
    defaultDurationSeconds: 5,
    defaultSteps: 10,
});
assert.deepEqual(sharedOnlyTiming.errors, []);

const fullyEmptyPlan = parsePlanJson(JSON.stringify({
    shots: [{id: "empty", prompt: ""}],
}));
const fullyEmptyTiming = calculatePlanTiming(fullyEmptyPlan, {
    contextLength: 22,
    anchorMode: "head",
    defaultDurationSeconds: 5,
    defaultSteps: 10,
});
assert.match(fullyEmptyTiming.errors.join("\n"), /scene and shared prompts are both empty/i);

const longPlan = parsePlanJson(JSON.stringify({
    defaults: {duration_seconds: 15, steps: 5},
    shots: Array.from({length: 14}, (_, index) => ({
        id: `clip_${String(index + 1).padStart(2, "0")}`,
        prompt: `Scene ${index + 1}`,
        ...(index === 13 ? {duration_seconds: 5} : {}),
    })),
}));
const longTiming = calculatePlanTiming(longPlan, {
    contextLength: 22,
    anchorMode: "head",
    defaultDurationSeconds: 15,
    defaultSteps: 20,
});
assert.equal(longTiming.totalFrames, 4544);
assert.equal(longTiming.totalSeconds, 189 + 1 / 3);
assert.deepEqual(longTiming.errors, []);

duplicateShot(plan.shots, 0);
assert.equal(plan.shots.length, 3);
assert.equal(plan.shots[1].id, "one_copy");
moveShot(plan.shots, 1, 2);
assert.equal(plan.shots[2].id, "one_copy");

const readable = JSON.parse(planToJson(plan));
assert.deepEqual(readable.prompt_prefix, ["New identity.", "", "New wardrobe."]);
assert.deepEqual(readable.shots[0].prompt, ["Opening.", "Keep moving."]);

const editorSource = fs.readFileSync(
    new URL("../web/h3_chain_plan_editor.js", import.meta.url),
    "utf8",
);
assert.match(editorSource, /collapseWidget\(planWidget\)/);
assert.match(editorSource, /display[^\n]+none[^\n]+important/);
assert.match(editorSource, /pointer-events[^\n]+none[^\n]+important/);
assert.match(editorSource, /widget\.onRemove\(\)/);
assert.match(editorSource, /const onAdded = nodeType\.prototype\.onAdded/);
assert.match(editorSource, /onGraphConfigured/);
assert.match(editorSource, /scheduleResponsiveSize\(\)/);
assert.doesNotMatch(editorSource, /height: \$\{EDITOR_HEIGHT\}px/);
assert.match(editorSource, /height: 100%/);
assert.match(editorSource, /contain: layout paint/);
assert.match(editorSource, /widget\.hidden = true/);
assert.match(editorSource, /widget\.draw = \(\) => \{\}/);
assert.match(editorSource, /node\.size\?\.\[1\][^\n]+0,/);
assert.doesNotMatch(editorSource, /const computed = node\.computeSize/);
assert.match(editorSource, /h3_chain_plan_layout/);
assert.match(editorSource, /new ResizeObserver/);
assert.match(editorSource, /"pointerdown", "pointerup", "mousedown", "mouseup", "click"/);
assert.match(editorSource, /availableReferenceRecords/);
assert.doesNotMatch(editorSource, /\[\["Picture", 9\], \["Video", 3\], \["Audio", 6\]\]/);
assert.match(editorSource, /Derived seed:/);
assert.match(editorSource, /New random/);
assert.match(editorSource, /Use derived/);
assert.match(editorSource, /Continuation into scene/);
assert.match(editorSource, /Guide · new shot/);
assert.match(editorSource, /Latent Guide · raw latent/);
assert.match(editorSource, /Masked AV · same shot/);
assert.match(editorSource, /Video context/);
assert.match(editorSource, /Audio context/);
assert.match(editorSource, /0 · new visual/);
assert.match(editorSource, /grid-template-columns:repeat\(4/);
assert.match(editorSource, /Hide advanced/);
assert.match(editorSource, /Show advanced/);
assert.doesNotMatch(editorSource, /Hide steps|Show steps/);
assert.match(editorSource, /h3_chain_scene_colors/);
assert.match(editorSource, /type = "color"/);
assert.match(editorSource, /minimax_h3_context_loop\.chain_plan_editor/);
assert.match(editorSource, /function folderOpenIcon\(\)/);
assert.match(editorSource, /createElementNS\(namespace, "svg"\)/);
assert.match(editorSource, /h3c-folder-icon/);
assert.match(editorSource, /minimax_h3_context_loop\/open-run-folder/);
assert.match(editorSource, /navigator\.clipboard\.writeText\(payload\.path\)/);
assert.match(editorSource, /plan_json_input/);
assert.match(editorSource, /External plan input connected/);
assert.match(editorSource, /non-empty upstream string controls execution/);
assert.match(editorSource, /onConnectionsChange/);
assert.doesNotMatch(editorSource, /h3_motion_context\.chain_plan_editor/);

console.log("H3 Chain Plan editor core: parsing, uint64 seeds, timing and edits pass");
