#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import {
    checkpointBranchRows,
    checkpointDeletionTitle,
    checkpointDependencyText,
    checkpointRevisionKey,
    formatCheckpointBytes,
    selectedCheckpointRevision,
} from "../web/h3_checkpoint_manager_core.mjs";

const a = "a".repeat(32);
const b = "b".repeat(32);
const c = "c".repeat(32);
const payload = {
    revisions: [
        {scene:1, scene_id:"arrival", revision:a, active:true,
            created_at:"2026-08-20T10:00:00Z"},
        {scene:2, scene_id:"hall", revision:b, active:true,
            created_at:"2026-08-20T10:10:00Z", context_length:39,
            audio_context_length:44, continuation_mode:"guide"},
        {scene:2, scene_id:"hall_alt", revision:c, active:false,
            created_at:"2026-08-20T10:20:00Z", context_length:0,
            audio_context_length:0, continuation_mode:"guide"},
    ],
    branches: [
        {id:"active", label:"Active branch", active:true,
            path:[{scene:1, revision:a}, {scene:2, revision:b}]},
        {id:"alternate", label:"Branch alternate", active:false,
            path:[{scene:1, revision:a}, {scene:2, revision:c}]},
    ],
};

assert.equal(formatCheckpointBytes(0), "0 B");
assert.equal(formatCheckpointBytes(1536), "1.5 KB");
assert.equal(formatCheckpointBytes(2 * 1024 ** 3), "2.00 GB");
assert.equal(checkpointRevisionKey(2, c.toUpperCase()), `2:${c}`);
assert.equal(selectedCheckpointRevision(payload, 2, c).revision, c);
assert.equal(selectedCheckpointRevision(payload, 2).revision, b);
assert.equal(checkpointBranchRows(payload)[0].revisions[1].revision, b);
assert.equal(checkpointBranchRows(payload)[1].revisions[0].revision, a,
    "a shared ancestor appears in every inferred branch that uses it");
assert.match(checkpointDependencyText(payload.revisions[1]),
    /Scene 2 · hall uses Video 39f \/ Audio 44f via guide/);
assert.match(checkpointDependencyText(payload.revisions[2]),
    /structural continuation edge \(Video 0f \/ Audio 0f\)/);
assert.match(checkpointDeletionTitle({allowed:true, owned_file_count:5,
    reclaimed_bytes:1536}), /Safe leaf deletion · 5 files · 1.5 KB/);
assert.equal(checkpointDeletionTitle({allowed:false,
    blockers:["A child depends on it."]}), "A child depends on it.");

const source = fs.readFileSync(
    new URL("../web/h3_chain_checkpoint_manager.js", import.meta.url), "utf8",
);
assert.match(source, /MiniMaxH3ChainCheckpointManager/);
assert.match(source, /MiniMaxH3ChainPlan/);
assert.match(source, /checkpoint-revisions\/delete-preview/);
assert.match(source, /checkpoint-revisions\/delete/);
assert.match(source, /snapshot:plan\.snapshot/);
assert.match(source, /window\.confirm/);
assert.match(source, /Delete dependent leaves first/);
assert.match(source, /shared, kept/);
assert.match(source, /checkpointRevisionKey\(revision\.scene, revision\.revision\)/);
assert.match(source, /`shared ×\$\{sharedCount\}`/);
assert.match(source, /card\.dataset\.sharedKey = key/);
assert.match(source, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "path"\)/);
assert.match(source, /h3cm-shared-link/);
assert.match(source, /padding-left:28px/);
assert.match(source, /matching color \+ side rail = same saved clip/);
assert.match(source, /pathData \+= ` M \$\{laneX\} \$\{anchor\.y\} H \$\{anchor\.x\}`/);
assert.doesNotMatch(source, /stroke-dasharray/);
assert.match(source, /new ResizeObserver\(scheduleSharedLinks\)/);
assert.match(source, /sharedLinksResizeObserver\?\.disconnect\(\)/);
assert.match(source, /Video \$\{record\.context_length\}f · Audio \$\{record\.audio_context_length\}f/);
assert.match(source, /addDOMWidget\("h3_checkpoint_manager"/);

const backend = fs.readFileSync(
    new URL("../chain_nodes.py", import.meta.url), "utf8",
);
assert.match(backend, /class MiniMaxH3ChainCheckpointManager/);
assert.match(backend, /def passthrough\(self, plan\):\s+return \(plan,\)/);
assert.doesNotMatch(
    backend.slice(
        backend.indexOf("class MiniMaxH3ChainCheckpointManager"),
        backend.indexOf("class MiniMaxH3ChainFirstSceneImage"),
    ),
    /ExecutionBlocker/,
);

console.log("H3 Checkpoint Manager frontend: branches, inspection and guarded deletion pass");
