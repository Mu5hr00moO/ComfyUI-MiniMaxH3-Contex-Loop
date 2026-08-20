# Runs, review, and recovery

## Review Gate

Place **Review Gate** between Segment + Checkpoint and Loop End. Each scene is
persisted before the gate waits, then the gate offers:

- **Approve & continue**
- **Retry prompt / seed**
- **Reroll seed**
- **Approve & stop**, optionally assembling a partial video

Notification sound, automatic timeout, and model unloading while waiting are
optional. Drag the bar below the player to resize it; double-click to restore
the default height.

When a Scene Prompt Editor or Rich Scene Prompt Editor is bound to the same
Plan, Review Gate selects the scene under review there automatically. Editor
changes appear in the Gate and **Retry prompt / seed** or **Reroll seed** uses
the live Plan prompt. The Gate prompt field remains an explicit fallback: if
you type in it, that text wins for the submitted retry and is synchronized back
to the Plan and connected editor after the server accepts it.

During sampling, the optional floating **Cancel & reroll scene N** control
targets only the active H3 prompt. It waits for confirmed interruption, writes a
new explicit scene seed, moves Loop Start to that scene, preserves a bounded
range end, and queues normally. Once saving or review begins, Review Gate owns
the retry instead.

Disable the floating control under **Settings → MiniMax H3 Contex Loop →
Interface → Cancel & reroll** without affecting Review Gate.

## Resume

For a fresh run:

```text
run_name: choose a new name
start_clip: 1
scene_range: blank
```

To resume scene N, keep the original `run_name` and dependency settings, then
set `start_clip: N`. The loop loads checkpoint N−1 and validates all completed
predecessors. Editing scene N or later is safe; changing an earlier prompt,
seed, timing, source waveform, Plan compatibility setting, or
`generation_fingerprint` invalidates the dependent resume.

Review Gate's checkpoint browser can set up this resume and preview the joined
partial through the selected predecessor.

### Restore an earlier scene revision

**Refresh** in Review Gate discovers the active checkpoint and every immutable
revision retained for that scene. Choose the scene to resume, then select the
desired version of each predecessor under **Checkpoint revisions**. Clicking
**Restore & load** validates the selected MP4, safetensors checkpoint, hashes,
shared prompt, and compatibility contract before atomically promoting the
selected prefix. The corresponding prompts, seeds, lengths, steps, and scene
identifiers are restored into the connected Plan, and Loop Start is armed for
the next scene.

The active versions are selected by default. Restoring an earlier version does
not delete the current one, so another revision can be promoted later. Exact
continuation requires the revision's checkpoint metadata and safetensors file;
an MP4 copied from `segments/` or `reviews/` alone cannot recreate the saved AV
latent. When only video survives, use Existing Video Context as a re-encoded
continuation instead.

Inactive leaf revisions can be deleted from the same panel to reclaim space.
Review Gate now retrieves a fresh server-side deletion preview before asking
for confirmation. Active revisions and revisions with dependent later scenes
cannot be deleted. Cleanup is limited to that revision's segment, safetensors
checkpoint, prompt/audio/blend sidecars, unshared preview, and versioned
metadata; Plan archives, assets, prompt history, assembled exports, and other
revisions are never included.

## Checkpoint Manager

Connect the active Plan output to **MiniMax H3 Checkpoint Manager**. It passes
the Plan through unchanged and never pauses execution, so it can stay between
Plan and the next consumer. The connected Plan preselects its run; the run
selector can inspect any other folder under `output/h3_chains`.

The manager groups immutable scene revisions into inferred branches. A revision
can appear in more than one branch when it is their shared ancestor. Selecting
a revision shows its saved preview, prompt, seed, timing, canvas, storage,
parent, following scenes, and the exact video/audio frame context those
following scenes consume. Older checkpoints derive this graph from predecessor
revision and checkpoint hashes; newly saved checkpoints also carry a stable
branch id and effective context fields.

Deletion is deliberately one scene revision at a time:

1. Select an inactive revision.
2. Inspect its complete file list, estimated reclaimed size, and preserved
   categories.
3. If later revisions depend on it, select and delete those leaf revisions
   first.
4. Confirm the now-safe leaf deletion. If anything changed after the preview,
   the server refuses it and asks for a fresh preview.

This first release does not bulk-delete branches. The leaf-first workflow makes
the exact context consequences visible and avoids silently orphaning later
checkpoints.

## Run Manager

Connect the active Plan output to **MiniMax H3 Run Manager**. It discovers runs
under the ComfyUI host's `output/h3_chains`, including remote Docker hosts.
Select a run and choose **Load into Plan**; after confirmation it restores
archived prompts and Plan controls without changing graph links.

Restore prefers:

1. `api_prompt.json`;
2. `workflow.json`;
3. effective settings derived from `plan.json` for older runs.

The fallback retains exact scene lengths, steps, and seeds even when an old run
did not archive unused default-widget values.

## Archive reference assets

Connect loader outputs to Run Manager's dynamic **Connect loader asset** socket,
up to 12 assets. Classify each as Picture, Video, Audio reference, or Source
track so a short voice reference cannot be confused with a project soundtrack.

- Archive images and audio default on.
- Archive video defaults off because video references can be large.
- Only files inside ComfyUI's input directory are eligible for fallback copies.
- Content-addressing deduplicates unchanged media and retains changed versions.

Restore first uses the original input-relative path. If it is missing and a
fallback exists, Run Manager copies the archived asset into a unique ComfyUI
input filename and updates a compatible loader. Targets are matched by persistent
binding identity, archived node ID/type, then unambiguous compatible loaders.
Ambiguous targets remain unchanged and are reported.

## Run folder contents

```text
output/h3_chains/<run_name>/
├── plan.json
├── workflow.json
├── api_prompt.json
├── manifest.json
├── prompt_history/<scene_id>/
├── segments/clip_0001.<revision>.mp4
├── segments/clip_0001.<revision>.prompt.txt
├── checkpoints/clip_0001.json
├── checkpoints/clip_0001.<revision>.json
├── checkpoints/clip_0001.<revision>.safetensors
├── generated_audio/
└── final/<filename>.mp4
```

Regenerating a scene updates its active checkpoint pointer but retains all
earlier MP4s, prompt sidecars, metadata, safetensors, and generated WAVs. Each
revision records what it supersedes.

Workflow and API graph metadata are embedded in segment/final files using
ComfyUI's standard tags. `workflow.json` is the preferred file to drag back
into ComfyUI; `plan.json` remains the authoritative effective render record.
Keep run folders private when workflows contain credentials.

## Assembly

Assemble accepts completed or partial manifests. Its filename supports date
tokens such as `%date:yyyy-MM-dd%`, `%year%`, `%month%`, `%day%`, `%hour%`,
`%minute%`, and `%second%`. Existing files are never overwritten; numbered
suffixes are added automatically.

Enable `copy_to_output` to keep the canonical final in the run folder and also
publish an MP4 into the regular ComfyUI output tree. `output_subfolder` is
relative to that output root, supports nested folders and the same date tokens,
and may be empty to place the copy directly in `output/`. The existing
`filename` value is used for both copies, and collisions are versioned.

## Re-decode checkpoints to PNG

Connect a manifest and the original H3 video VAE to **Export PNG Sequence**. It
verifies each safetensors checkpoint, decodes one scene at a time, removes the
repeated overlap, and writes a continuous 8-bit RGB PNG sequence plus
`export.json` under:

```text
output/h3_chains/<run_name>/frames/<export_name>/
```

PNG compression is lossless. Use the same VAE, ComfyUI version, precision, and
decode settings for the closest reconstruction. The checkpointed latent is
exact, but a new VAE decode is not guaranteed to be bit-identical to an older
decode made under different settings.
