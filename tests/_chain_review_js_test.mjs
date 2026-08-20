import assert from "node:assert/strict";
import fs from "node:fs";
import {
    applyCheckpointRevisionSet,
    applyReviewEdit,
    checkpointRevisionChain,
    checkpointResumeOptions,
    reviewCountdown,
    reviewDuration,
    reviewDurationText,
    reviewLocalDeadline,
    reviewPlanScenePrompt,
    reviewSeed,
} from "../web/h3_chain_review_core.mjs";

assert.equal(reviewSeed("18446744073709551615"), "18446744073709551615");
assert.throws(() => reviewSeed("18446744073709551616"), /uint64/);
assert.deepEqual(reviewDuration("15"), {seconds: 15, length: 362});
assert.equal(reviewDurationText(362), "15.083333");
for (const length of [5, 22, 39, 56, 73, 362, 3592]) {
    assert.equal(reviewDuration(reviewDurationText(length)).length, length);
}
assert.throws(() => reviewDuration("0"), /positive/);

assert.equal(reviewPlanScenePrompt({shots: [
    {id: "one", prompt: ["First."]},
    {id: "two", prompt: ["Second.", "", "CAMERA: Wide."]},
]}, 2, "two"), "Second.\n\nCAMERA: Wide.");
assert.equal(reviewPlanScenePrompt({shots: [
    {id: "two", prompt: ["Moved second."]},
    {id: "one", prompt: ["Moved first."]},
]}, 2, "two"), "Moved second.", "scene id wins if the Plan was reordered");
assert.equal(reviewPlanScenePrompt({shots: []}, 1, "missing"), null);

const plan = {
    prompt_prefix: ["Keep identity."],
    shots: [
        {id: "one", prompt: ["Old one."], seed: "1"},
        {id: "two", prompt: ["Old two."], seed: "2"},
    ],
};
applyReviewEdit(plan, 2, "New two.\n\nCAMERA: Close-up.", "9007199254740993", 56);
assert.deepEqual(plan.shots[0].prompt, ["Old one."]);
assert.deepEqual(plan.shots[1].prompt, ["New two.", "", "CAMERA: Close-up."]);
assert.equal(plan.shots[1].seed, "9007199254740993");
assert.equal(plan.shots[1].length, 56);
applyReviewEdit(plan, 1, "", "3");
assert.deepEqual(plan.shots[0].prompt, [""]);
assert.equal(plan.shots[0].seed, "3");
assert.throws(
    () => applyReviewEdit({shots: [{prompt: [""]}]}, 1, "", "4"),
    /scene prompt or shared prompt/i,
);

assert.deepEqual(reviewCountdown(130, 100_000), {seconds: 30, text: "0:30"});
assert.deepEqual(reviewCountdown(100, 100_001), {seconds: 0, text: "0:00"});
assert.equal(reviewCountdown(null, 0), null);
assert.equal(reviewLocalDeadline(null, 100, 100_000), null);
assert.equal(reviewLocalDeadline(undefined, 100, 100_000), null);
assert.equal(reviewLocalDeadline("", 100, 100_000), null);
assert.equal(reviewLocalDeadline(130, 100, 100_000), 130);

assert.deepEqual(checkpointResumeOptions([
    {scene: 2, resume_scene: 3, scene_id: "second", ready: true,
        video: {filename: "second.mp4"}},
    {scene: 1, resume_scene: 2, scene_id: "first", ready: true,
        partial_video: {filename: "partial.mp4"}},
    {scene: 3, resume_scene: 4, scene_id: "final", ready: true},
    {scene: 1, resume_scene: 2, scene_id: "broken", ready: false},
], 3), [
    {savedScene: 1, resumeScene: 2, sceneId: "first", video: null,
        partialVideo: {filename: "partial.mp4"}},
    {savedScene: 2, resumeScene: 3, sceneId: "second",
        video: {filename: "second.mp4"}, partialVideo: null},
]);

const revisionA = "a".repeat(32);
const revisionB = "b".repeat(32);
const revisionC = "c".repeat(32);
assert.deepEqual(checkpointRevisionChain([
    {scene: 1, revision: revisionA, active: false, ready: true,
        created_at: "2026-08-14T09:00:00", seed: "11", size_bytes: 1024},
    {scene: 1, revision: revisionB, active: true, ready: true,
        created_at: "2026-08-14T10:00:00", seed: "12", size_bytes: 2048},
    {scene: 2, revision: revisionC, active: true, ready: true,
        created_at: "2026-08-14T11:00:00", seed: "13", size_bytes: 4096},
    {scene: 2, revision: "invalid", active: false, ready: true},
], 3), [
    {scene: 1, revisions: [
        {scene: 1, sceneId: "clip_0001", revision: revisionB, active: true,
            createdAt: "2026-08-14T10:00:00", seed: "12", sizeBytes: 2048,
            promptPreview: "", video: null},
        {scene: 1, sceneId: "clip_0001", revision: revisionA, active: false,
            createdAt: "2026-08-14T09:00:00", seed: "11", sizeBytes: 1024,
            promptPreview: "", video: null},
    ]},
    {scene: 2, revisions: [
        {scene: 2, sceneId: "clip_0002", revision: revisionC, active: true,
            createdAt: "2026-08-14T11:00:00", seed: "13", sizeBytes: 4096,
            promptPreview: "", video: null},
    ]},
]);
assert.deepEqual(checkpointRevisionChain([
    {scene: 2, revision: revisionC, active: true, ready: true},
], 3), [], "a recoverable chain must include every predecessor scene");

const recoveredPlan = applyCheckpointRevisionSet({
    prompt_prefix: ["new prefix"],
    shots: [
        {id: "one", prompt: ["new one"], length: 362, steps: 8, seed: "1",
            context_length: 39, audio_context_length: 44},
        {id: "two", prompt: ["new two"], length: 362, steps: 8, seed: "2",
            context_length: 39, audio_context_length: 44},
    ],
}, [
    {scene: 1, scene_id: "old_one", scene_prompt: "old one", seed: "101",
        raw_frames: 345, steps: 6, prompt_prefix: "old prefix", context_length: 0,
        audio_context_length: 33},
    {scene: 2, scene_id: "old_two", scene_prompt: "old two", seed: "102",
        raw_frames: 328, steps: 7, prompt_prefix: "old prefix"},
]);
assert.deepEqual(recoveredPlan.prompt_prefix, ["old prefix"]);
assert.deepEqual(recoveredPlan.shots, [
    {id: "old_one", prompt: ["old one"], length: 345, steps: 6, seed: "101",
        context_length: 0, audio_context_length: 33},
    {id: "old_two", prompt: ["old two"], length: 328, steps: 7, seed: "102"},
]);

const reviewSource = fs.readFileSync(
    new URL("../web/h3_chain_review_final.js", import.meta.url),
    "utf8",
);
assert.match(reviewSource, /minimax_h3_context_loop\/review/);
assert.match(reviewSource, /minimax_h3_context_loop_review_resolved/);
assert.match(reviewSource, /item\.name === "scene_range"/);
assert.match(reviewSource, /rangeWidget\.value = ""/);
assert.match(reviewSource, /_h3QueuedReview/);
assert.match(reviewSource, /setInterval[\s\S]*fetchPending/);
assert.match(reviewSource, /addEventListener\("status", fetchPending\)/);
assert.match(reviewSource, /async nodeCreated\(node\)/);
assert.match(reviewSource, /gates\.length === 1/);
assert.match(reviewSource, /data\?\.run_name/);
assert.match(reviewSource, /mountedReviewNodes/);
assert.match(reviewSource, /split\(\/\[\.:\]\//);
assert.match(reviewSource, /No pending review is available for this project yet/);
assert.match(reviewSource, /button\.disabled = false/);
assert.doesNotMatch(
    reviewSource,
    /await fetchPending\(\);\s*return;/,
    "an action click must continue after recovering its pending token",
);
assert.match(reviewSource, /"pointerdown", "pointerup", "mousedown", "mouseup", "click"/);
assert.match(reviewSource, /preview_revision/);
assert.match(reviewSource, /sameToken/);
assert.match(
    reviewSource,
    /if \(!sameToken\)[\s\S]*setTimeout\(refreshResumeOptions, 0\)/,
    "a newly persisted review scene must refresh checkpoint history",
);
assert.match(
    reviewSource,
    /data\.action === "approve" \|\| data\.action === "stop"[\s\S]*setTimeout\(refreshResumeOptions, 0\)/,
    "final approval must refresh checkpoint history",
);
assert.match(reviewSource, /Checkpoint history/);
assert.match(reviewSource, /const refreshToken = \+\+resumeRefreshToken/);
assert.match(reviewSource, /if \(refreshToken !== resumeRefreshToken\) return/);
assert.match(reviewSource, /candidate_revision/);
assert.match(reviewSource, /Use selected take & continue/);
assert.match(reviewSource, /exact video and audio continuation tensors/);
assert.match(reviewSource, /Candidate \$\{candidate\.number\}\/\$\{current\.candidate_count\}/);
assert.match(
    reviewSource,
    /checkpointRevisionChain\(\s*checkpointRevisions, planClipCount \+ 1/,
    "checkpoint history must include the final scene, even though it cannot be a resume predecessor",
);
assert.match(reviewSource, /revision\.scene < selectedResumeScene/);
assert.match(reviewSource, /data\.final_video \?\? data\.partial_video/);
assert.match(reviewSource, /final assembled video/);
assert.match(reviewSource, /Duration \(s\)/);
assert.match(reviewSource, /body\.length/);
const submitStart = reviewSource.indexOf("async function submit");
const submitSource = reviewSource.slice(
    submitStart,
    reviewSource.indexOf("node._h3ReviewHandler", submitStart),
);
assert.match(submitSource, /const submittedToken = submittedReview\.token/);
assert.match(submitSource, /const submittedIndex = submittedReview\.clip_index/);
assert.match(submitSource, /promptEditedInGate[\s\S]*planScenePrompt/);
assert.match(submitSource, /token: submittedToken/);
assert.match(submitSource, /scene_prompt: submittedPrompt/);
assert.match(
    submitSource,
    /updatePlan\(\s*node, submittedIndex, acceptedPrompt, body\.seed, body\.length\)/,
);
assert.match(reviewSource, /publishCompanionPrompt/);
assert.match(reviewSource, /publishPlanCompanionScene/);
assert.match(reviewSource, /_h3PromptCompanionSetScenePrompt/);
assert.match(reviewSource, /reviewDurationText\(data\.raw_frames\)/);
assert.match(reviewSource, /h3r-video-panel/);
assert.match(reviewSource, /checkpoint-revisions\/restore/);
assert.match(reviewSource, /checkpoint-revisions\/delete-preview/);
assert.match(reviewSource, /checkpoint-revisions\/delete/);
assert.match(reviewSource, /snapshot: preview\.snapshot/);
const checkpointLoadStart = reviewSource.indexOf(
    'loadResume.addEventListener("click"',
);
const checkpointLoadSource = reviewSource.slice(
    checkpointLoadStart,
    reviewSource.indexOf("function stopCountdown", checkpointLoadStart),
);
assert.match(checkpointLoadSource, /include_assets: "false"/);
assert.match(checkpointLoadSource, /restoreSavedPlanInputs\(node, runBody\.plan_inputs\)/);
assert.match(checkpointLoadSource, /if \(selections\.length\)/);
assert.ok(
    checkpointLoadSource.indexOf("restoreSavedPlanInputs")
        < checkpointLoadSource.indexOf("prepareResume"),
    "the complete saved Plan must be restored before Loop Start is armed",
);
assert.match(reviewSource, /Permanently delete scene/);
assert.match(reviewSource, /Restore & load/);
assert.match(reviewSource, /h3r-video-grip/);
assert.match(reviewSource, /h3_chain_review_video_height/);
assert.match(reviewSource, /h3_chain_review_prompt_height/);
assert.match(reviewSource, /promptResizeObserver = new ResizeObserver/);
assert.match(reviewSource, /_h3ReviewApplyLayout/);
assert.match(reviewSource, /nodeType\.prototype\.onConfigure/);
assert.match(reviewSource, /setPointerCapture/);
assert.match(reviewSource, /visualHeight \/ layoutHeight/);
assert.match(reviewSource, /videoPanel\.offsetHeight, true/);
assert.doesNotMatch(reviewSource, /\/h3_motion_context\/review/);

console.log("H3 Chain Review editor helpers: ok");
