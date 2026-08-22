# Changelog

Newest first. This file keeps release history out of the onboarding README.

## Unreleased

### Scene-guide continuation and diagnostics

- Added `latent_guide` continuation. Generated scene-to-scene transitions copy
  the previous sampler's raw H3 video/audio latent tail directly into the next
  target and preserve that prefix with per-stream AV denoise masks, avoiding a
  video VAE round trip. Imported scene 1 uses the masked decoded-frame VAE
  fallback because no sampled predecessor latent exists yet.
- Added **MiniMax H3 Guide Image** and **MiniMax H3 Guide Images to Video** for
  arbitrary image anchors. With Chain state, guides use scene-local delivered
  frame indices, scene N inherits scene N−1 frame `-1` as its start, and
  `latent_guide` keeps that inherited start on the preserved-prefix boundary.
- Added opt-in **MiniMax H3 Contex Loop Full Segment Save**. It keeps the normal
  delivered segment/checkpoint/revision/audio path unchanged and additionally
  saves the decoded pre-Trim sample under `full_segments/` for visual seam
  diagnosis.

### Deferred checkpoint upscaling

- Added a backend-neutral recursive upscale child run: Checkpoint Manager Plan
  passthrough → Upscale Adapter → Current Scene → H3/LTX/custom backend →
  Segment Save → Loop End → Merger. Each profile is isolated under the parent
  run's `upscaled/<profile>` folder with verified resume metadata.
- Upscale Current Scene prefers an explicitly saved denoised H3 x0 and exposes
  joint AV plus split video/audio latent routes for both combined and
  video-only learned H3 upscaler nodes. Older terminal-latent checkpoints remain
  supported, and decoded-video LTX 2.5 passes use the same orchestration.
- Made persistence of the large HQ latent optional and off by default. A small
  self-contained assembly/audio checkpoint is still written for reliable
  resume and final merge.
- Added a standalone learned-H3 2x example workflow that loads a complete
  branch through Checkpoint Manager, rebuilds scene conditioning, runs a
  Tr1dae staggered pass-2 loop, and merges the isolated child profile.

## v0.4.20 — Modern editable-install metadata

- Added an explicit setuptools build backend and disabled accidental discovery
  of asset and workflow folders as Python packages, so `pip install -e .`
  succeeds with current setuptools releases.
- Replaced deprecated license metadata with its SPDX form while leaving the
  repository's GPL v3 license text unchanged. Thanks to @ed45626 in PR #27.

## v0.4.19 — Cleaner shared-checkpoint links

- Moved shared-revision connectors into a dedicated side gutter with thin
  solid rails and short taps to each matching card, keeping lineage marks away
  from branch names, revision text, and status labels.

## v0.4.18 — Review candidate batches and checkpoint refresh

- Review Gate can now generate 1–20 different-seed takes for each scene,
  present them together, and continue from the exact saved video/audio
  checkpoint selected by the user. The default remains one take.
- Selecting an earlier take atomically promotes its checkpoint and recovery
  Plan before the loop continues, so later scenes and interrupted-run recovery
  follow the chosen branch rather than the last generated take.
- Fixed overlapping checkpoint refresh requests adding duplicate choices after
  workflow reload, and clarified that rejected, rerolled, and candidate takes
  remain as intentional immutable recovery revisions until explicitly deleted.

## v0.4.17 — Shared checkpoint lineage visibility

- Repeated checkpoint revisions now keep the existing branch layout while
  receiving a consistent color label and a vertical connector between every
  branch line that shares the same clip.

## v0.4.16 — Checkpoint Manager

- Added a Plan-passthrough Checkpoint Manager that browses every saved run by
  scene and inferred revision branch, previews saved video/audio, and exposes
  prompts, seeds, frame counts, compatibility data, storage, lineage, and the
  exact incoming video/audio context for each revision.
- Added dependency-aware cleanup. Active revisions and revisions used by later
  scenes are protected; the manager identifies every dependent scene and lets
  users work backward from a leaf one revision at a time.
- Added a two-step deletion contract shared with Review Gate. The server
  previews every owned/shared file and preserved archive category, then rejects
  confirmation if files, active pointers, or descendants changed in between.
- New checkpoints persist creation time, effective continuation context, and a
  stable branch identity so future runs need less lineage inference while old
  checkpoint folders remain fully discoverable.

## v0.4.15 — Light-theme prompt editor contrast

- Made titles, active controls, and rich reference tags derive their semantic
  colors from the active ComfyUI foreground. Both scene prompt editors retain
  their pastel dark-theme palette while gaining readable contrast in light
  themes.

## v0.4.14 — Prompt editor undo

- Added shared text-level Ctrl/Cmd+Z and redo history to both dedicated scene
  prompt editors. Undo now survives rich-tag DOM decoration, plain-text paste,
  toolbar insertion, Plan synchronization, and switching between rich and
  plain presentation.

## v0.4.13 — Native mask readiness gate

- Fixed the masked-AV preflight after merged PR #15375 removed
  `process_denoise_mask`. The gate now uses the capability module's runtime
  readiness check instead of requiring that obsolete method by name.

## v0.4.12 — Merged H3 mask API compatibility

- Recognized the final helper-based API merged by ComfyUI PR #15375 and left
  current ComfyUI fully native. The old-build fallback now mirrors merge-time
  commit `c676536`, including pooled token-grid masks and ceil-quantized mask
  strengths, while recognized pre-merge wrappers are upgraded safely.

## v0.4.10 — Final-output publishing

- Fixed scene and final MP4 publication in ComfyUI's global Media Assets panel
  by using the native animated-video output descriptor recognized by job
  history.
- Added optional Final Assemble controls to copy the completed MP4 into the
  regular ComfyUI output tree. The relative subfolder supports nested folders
  and date tokens, an empty value targets the output root, and collisions are
  versioned without replacing the canonical chain final.

## v0.4.9 — Defensive Sol-Attn observer detection

- Fixed folder-independent Sol-Attn recognition for the defensive
  `getattr(self, "segments", ...)` observer used by the Kitchen PR helper,
  while continuing to require the complete `_video_span`, `_SPANS`,
  `position_ids`, and `segments` fingerprint. Thanks to @tsolful in PR #16
  for identifying the bytecode lookup difference.

## v0.4.8 — Renamed Sol-Attn observer compatibility

- Made Sol-Attn H3 layout-observer compatibility independent of the custom
  node's install-folder name. Renamed PR helpers such as
  `sol_attn_minimax_v2`, lazy installation between scene 1 and scene 2, and
  nested read-only observer copies now preserve native Add Guide detection;
  unrelated layout-mutating wrappers remain refused.

## v0.4.7 — Review/editor synchronization and compatibility

- Synchronized Review Gate with prompt editors bound to the same Plan. A new
  review activates its scene in the connected editor, live editor changes are
  reflected in the Gate, and retry/reroll reads the current Plan prompt unless
  the Gate field was explicitly edited as a fallback.
- Removed the core Ref2VA right-click conversion into Scheduled Ref2VA and its
  graph-rewriting implementation. Scheduled and Tagged Ref2VA remain available
  as explicit nodes.
- Recognized the audited path-valued H3 layout observer installed by the
  `ComfyUI-SolAttn-CUDA-PR117` development checkout, while continuing to reject
  unknown wrappers.
- Rotated every browser helper-module cache token with the release so the new
  Review Gate/core export contract cannot be mixed with cached v0.4.6 modules.

## v0.4.6 — Asset publishing and media fallbacks

- Scene Segment Save and Final Assemble now publish their MP4 paths through
  ComfyUI's standard output descriptor contract, so newly produced scene clips
  and final videos appear promptly in the global Assets sidebar when enabled.
- FFmpeg executables found on `PATH` are now launch-tested once before use. A
  broken Windows build (including `0xC0000139` DLL entry-point failures) is
  treated as unavailable so review muxing and final assembly use PyAV instead.
- Versioned every production `.mjs` import with the package release and added
  a consistency regression check, preventing stale browser helper modules from
  disabling the Plan DOM editor after an update.

## v0.4.5 — Scene context and checkpoint Plan recovery

- Added per-scene context-length overrides to the Plan's existing Advanced
  controls and Plan Studio. Blank inherits the Plan default; `0` creates a
  visually independent scene.
- Added an independent per-scene generated-audio context override. A guide
  scene can now use zero video context while retaining preceding dialogue,
  ambience, or music; explicit audio `0` disables the carry, while masked AV
  remains locked to one synchronized prefix.
- Made timing, masked/guide behavior, imported-video scene 1 handling, resume
  hashes, checkpoint tail storage, Run Manager recovery, and checkpoint
  revision recovery preserve the effective per-scene context.

- Made Review Gate's ordinary **Load checkpoint** action restore the saved
  run's complete Plan before arming Loop Start. Prompts and Plan settings no
  longer remain from whichever workflow happened to be open.
- Reapplied the exact selected checkpoint metadata for every saved predecessor
  scene, including active revisions, while keeping plan-only recovery free of
  archived-asset materialization side effects.

## v0.4.4 — Review retry persistence

- Kept each Review Gate retry's edited scene prompt, seed, and length bound to
  the same submitted scene while the server request is in flight.
- Made the server return the accepted prompt and synchronized it into the Plan
  and any open prompt companion editor, preventing stale UI state from
  replacing the retry prompt.

## v0.4.3 — Per-scene continuation modes

- Added per-scene `continuation_mode` overrides in Plan JSON, the compact Plan
  editor advanced controls, and Plan Studio. The Plan node setting remains the
  inherited default, so one chain can use flexible `guide` transitions for new
  shots and exact `masked_av` transitions for continued shots.
- Fixed ComfyUI Stop/Cancel while execution is waiting indefinitely at Review
  Gate; the gate heartbeat now observes the processing-interrupted flag and
  resolves its browser controls before propagating the normal interruption.
- Added experimental Plan `continuation_mode=masked_av`. Chain Context
  VAE-encodes the preceding scene's decoded tail into the next target video
  latent, copies the matching sampled audio-latent tail, and emits nested
  per-stream masks where `0` preserves the prefix and `1` generates the future.
- Appended a sampler-ready LATENT output to Chain Context without changing its
  existing output indices; guide mode and scene 1 pass the original latent
  through unchanged.
- Added lazy native-first PR #15375 compatibility for H3 mask payloads,
  preprocessing, inpaint scaling, and per-row diffusion timesteps.
- Converted Studio Tagged into the wired 39-frame / 65-audio-step masked AV
  example while retaining Tagged Ref2VA and Plan Studio authoring.

## v0.4.2 — Checkpoint revision recovery

- Extended the existing Review Gate checkpoint browser to discover every
  retained scene revision, preview it, and restore a selected predecessor
  chain before resuming the next scene.
- Restoring revisions updates the editable Plan's scene prompts, seeds,
  lengths, steps, identifiers, and shared prompt before Loop Start is armed.
- Added guarded cleanup for inactive revisions. Review Gate shows each
  revision's estimated storage and requires an explicit permanent-delete
  confirmation; active pointers and unrelated run files cannot be removed.

## v0.4.1 — Tagged source audio and UI fixes

- Added `source_timeline` playback to Tagged Audio Ref. It fingerprints the full
  Loop source track while Tagged Ref2VA derives each exact scene slice from
  Current Shot state, avoiding the circular dependency caused by returning a
  dynamically sliced audio fingerprint to Plan.
- Corrected every maintained Ref2V example to load the Ref2VA diffusion model
  instead of the FL2VA checkpoint inherited from the workflow template.
- Kept the Run Manager's serialized asset-binding state hidden across legacy
  and current canvas renderers so its internal JSON field cannot leak into the
  visible node layout.
- Constrained the main Plan editor to its assigned DOM-widget bounds and fully
  suppressed its internal `plan_json` canvas widget, preventing an intermittent
  invisible hit layer from blocking the native Plan settings.

## v0.4.0 — Prompt-driven Ref2VA and Studio authoring

- Added Tagged Picture, Video, and Audio references. Register stable aliases
  such as `@hero`, `@motion`, and `@voice`; only tags present in the resolved
  scene prompt are sent to H3 and compacted to native media labels.
- Retained numeric-range Scheduled Ref2VA under the legacy-schedule category
  for workflows that need explicit scene selectors.
- Added optional Plan Studio and Rich Scene Prompt Editor authoring, including
  synchronized scene selection, rich reference chips and previews, prompt
  revisions, and configurable Direct API or MCP prompt optimization.
- Added maintained T2V and I2V Normal/Studio pairs, indexed A→B→A FL2V, Basic /
  Tagged / Studio Tagged Ref2V, and an experimental advancing motion-reference
  workflow. Previous examples remain archived rather than deleted.
- Added cumulative disk-backed visual blending, final-assembly playback in
  Review Gate, editable retry duration, and exact scene retiming.
- Added native first/last-frame reference previews that follow the active frame
  index, plus prompt-driven image, video, and audio miniatures.
- Added portable Run Manager asset restoration to the Studio Tagged example.
- Updated compatibility for merged ComfyUI PR #15439: current ComfyUI owns H3
  guide placement and payload merging; older builds receive one warning before
  the guarded fallback is used.
- Added an optional external Plan JSON STRING input for provider-independent
  story-director and LLM workflows.

Credit: native H3 guide support is by **drozbay**; cumulative audio budgeting
was inspired by **seitanism**; the editor interaction pattern was inspired by
**nkxx188's ComfyUI-MiniMaxH3-Easy**. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the complete attribution.

## v0.3.28 — PyAV audio rounding tolerance

Final PyAV muxing tolerates and zero-pads a single missing sample caused by
frame-to-sample rounding while continuing to reject larger audio deficits.

## v0.3.27 — True disabled scheduler compliance

Disabled policy reaches upstream Schedule nodes, converts scheduler-owned
validation into warnings, and omits unusable media. An empty
`source_audio_slice` left wired in `generated_audio` mode no longer stops a
render.

## v0.3.26 — Three-level prompt compliance

Scheduled Ref2VA offers strict, soft, and disabled policy. Strict blocks
scheduler mistakes; soft relaxes prompt-alias failures; disabled passes prompt
text through unchanged and makes scheduler checks non-blocking.

## v0.3.25 — Portable run assets and optional tag warnings

Run Manager accepts dynamic loader-asset connections, records persistent
binding identities and original input paths, and can retain content-addressed
image/audio/video fallbacks under the run folder. Restore prefers the original
input file and materializes an archived fallback only when needed. Scheduled
Ref2VA can downgrade unresolved prompt-tag failures to visible log warnings.

## v0.3.24 — Saved Run Manager

A companion node browses projects under `output/h3_chains`, reports scene and
checkpoint details, and restores archived prompts and Plan settings after
confirmation. Exact API/workflow inputs are preferred, with `plan.json` as the
older-run fallback.

## v0.3.23 — Branching scene-prompt history

The Scene Prompt Editor keeps lazy per-scene revisions outside workflow and
Plan JSON. Its compact `‹ 2 / 5 ›` control navigates versions, shows execution
state and timestamp, and creates a child branch when an executed revision is
edited.

## v0.3.22 — Optional floating reroll control

A ComfyUI setting under **MiniMax H3 Contex Loop → Interface → Cancel &
reroll** can hide the floating in-progress action. Review Gate controls remain
available.

## v0.3.21 — Upstream continuity update and exact assembly

Motion Context preserves a stock H3 `last_frame` target while replacing a
conflicting first-frame anchor with its carried head. Added 56-frame context,
the in-graph Seam Probe, cumulative generated-audio sample budgeting, and
stitcher-ready retained visual overlap. The cumulative-audio approach was
inspired by **seitanism's**
[MultiRef implementation](https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef).

## v0.3.20 — Cancel and reroll the active scene

During generation, a guarded floating action can cancel only the active prompt,
assign a new explicit scene seed, preserve the selected range end, and requeue
through ComfyUI's normal queue.

## v0.3.19 — Plan and review UX pass

Plan controls retain pointer input, editor and preview sizes persist, scene
seeds remain visible, and reference menus show only sources active in the
selected scene. Documentation clarifies that `@aliases` are optional.

## v0.3.14 — Explicit compatible patch priority

The optional wired **MiniMax H3 Patch Priority** pass-through can promote this
pack over an older compatible Motion Context copy while retaining recognized
H3-Multishot and SolAttn behavior.

## v0.3.13 — Open a Plan's output folder

A compact **Output** action creates and opens
`output/h3_chains/<run_name>` on the ComfyUI host. Headless hosts fall back to
copying the host path into the browser clipboard.

## v0.3.12 — Clearer Plan guidance and looping I2VA

Expanded Plan tooltips, clarified audio modes and seed rerolls, and added a
single-image I2VA example plus First-Scene Image Gate.

## v0.3.11 — Invisible legacy widget-width repair

While a Contex Loop node is on the canvas, the pack repairs the LiteGraph
widget-width regression across all nodes. Regenerated scenes retain previous
segment and checkpoint revisions instead of deleting the superseded take.

## v0.3.10 — Scene-scheduled Ref2VA

Added chained picture, video, paired-video-audio, and standalone-audio
references under stable `@tags`, with per-scene activation and compact native
label numbering. A right-click converter migrates an already-wired core Ref2VA
node.

## v0.3.8 — One-pass performance re-filming

Reference Video Prep converts native VIDEO or decoded IMAGE/AUDIO to exact
24 fps Ref2VA input, copies its soundtrack without padding or time-stretching,
and powers the experimental three-angle guitar workflow.

## v0.3.7 — Flexible video loaders

Existing Video Context accepts either native ComfyUI VIDEO or separate
IMAGE + AUDIO + FPS outputs.

## v0.3.6 — Extend an existing video

A typed adapter turns decoded video and optional audio into scene 1 context,
with optional normalized-source prepend for partial and final output.

## v0.3.5 — Native guides and portable assembly

Added automatic support for ComfyUI's native arbitrary-position AV guides,
retained the guarded legacy path, and added PyAV fallback when `ffmpeg` is not
available.

## v0.3.4 — Scene Prompt Editor

Added the synchronized large-format scene editor with navigation, reference and
dialogue shortcuts, and adjustable type size.

## v0.3.3 — Reliable preview resizing

Review video sizing remains stable when the ComfyUI canvas is zoomed.

## v0.3.2 — Resizable review video

The bar beneath Review Gate's player adjusts preview height.

## v0.3.1 — Friendlier JSON defaults

Top-level `duration_seconds` and `steps` shorthand populate visual Plan defaults
correctly.

## v0.3.0 — Archival PNG export

Saved scene checkpoints can be re-decoded into a continuous lossless PNG
sequence without holding the complete production in RAM.

## v0.2.0 — Recovery, metadata, and compatibility

- Persisted each scene prompt, effective plan, workflow, and API prompt beside
  the rendered chain.
- Added scene-range rendering, resumable review checkpoints, partial assembly,
  notification/timeout controls, and Firefox-safe Review Gate recovery.
- Added guarded compatibility with H3-Multishot, SolAttn, Ref2VA, and upstream
  H3 Motion Context.
- Added Comfy Registry publishing and a shorter project-focused README.

## v0.1.0 — The production loop takes shape

- Introduced the visual scene-plan editor, multiline prompts, automatic scene
  colors, responsive layout, and collapsible raw JSON.
- Added the recursive one-body chain, frame-locked audio trimming, per-scene
  checkpoints, interactive review/retry, and looping Ref2VA example.
- Renamed the expanded project **MiniMax H3 Contex Loop** so it could coexist
  clearly with NikoDemon80's manual Motion Context tools.

## Origins — Motion Context and Ref2VA continuation

The project began with MiniMax H3 clip chaining and generated-audio
continuation, then added Ref2VA Motion Context, opt-in compatibility patches,
and the resumable disk-backed production loop.
