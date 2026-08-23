#!/usr/bin/env node

import assert from "node:assert/strict";
import {
    CONTINUATION_MODES,
    calculatePlanTiming,
    parsePlanJson,
    sceneContinuationMode,
} from "../web/h3_chain_plan_core.mjs";

assert.ok(CONTINUATION_MODES.includes("raw_guide"));
assert.equal(sceneContinuationMode({}, "raw_guide"), "raw_guide");
assert.equal(
    sceneContinuationMode({continuation_mode: "raw_guide"}, "guide"),
    "raw_guide",
);

const plan = parsePlanJson(JSON.stringify({
    shots: [
        {id: "one", prompt: "Opening."},
        {id: "two", prompt: "Continue.", continuation_mode: "raw_guide"},
    ],
}));

const valid = calculatePlanTiming(plan, {
    contextLength: 22,
    encodeMode: "video",
    anchorMode: "head",
    continuationMode: "guide",
    defaultDurationSeconds: 5,
});
assert.equal(valid.shots[1].continuationMode, "raw_guide");
assert.deepEqual(valid.errors, []);

assert.match(calculatePlanTiming(plan, {
    contextLength: 1,
    encodeMode: "video",
    anchorMode: "head",
    continuationMode: "guide",
    defaultDurationSeconds: 5,
}).errors.join("\n"), /Raw Guide requires a context length of at least 5/);

assert.match(calculatePlanTiming(plan, {
    contextLength: 22,
    encodeMode: "frames",
    anchorMode: "head",
    continuationMode: "guide",
    defaultDurationSeconds: 5,
}).errors.join("\n"), /Raw Guide requires video encode mode/);

assert.match(calculatePlanTiming(plan, {
    contextLength: 22,
    encodeMode: "video",
    anchorMode: "before",
    continuationMode: "guide",
    defaultDurationSeconds: 5,
}).errors.join("\n"), /Raw Guide requires head anchor mode/);

console.log(
    "raw guide Plan core: vocabulary, 22-frame timing, and video/head constraints passed",
);
