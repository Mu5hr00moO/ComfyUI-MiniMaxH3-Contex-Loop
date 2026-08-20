<p align="center">
  <img src="assets/minimax-h3-contex-loop.svg" alt="MiniMax H3 Contex Loop v0.4 — scene plans that survive the render" width="100%">
</p>

# ComfyUI MiniMax H3 Contex Loop

Turn one MiniMax H3 sampling body into a scene-by-scene production loop. Each
accepted scene carries motion and optional audio forward, saves a resumable
checkpoint, can be reviewed or retried, and joins into a final video without a
giant cumulative image tensor.

[Install](#install) · [Choose a workflow](#choose-a-workflow) ·
[Documentation](#documentation) · [Changelog](CHANGELOG.md)

> **Contex** is the intentional public repository spelling.

## What you get

| | Feature |
|---|---|
| 🎬 | Visual multiline scene planner with exact H3 timing |
| 🔁 | One recursive sampling body for a complete scene plan |
| 🧬 | Motion and optional generated-audio continuity |
| 🏷️ | Prompt-driven picture, video, and audio references with stable `@tags` |
| 🗓️ | Optional legacy scene-range scheduling for explicit reference control |
| 👀 | Video-with-sound review, prompt retry, and seed reroll |
| 💾 | Atomic checkpoints, partial assembly, and safe resume |
| 🕘 | Branching prompt history and saved-run restoration |
| 🧭 | Optional Plan Studio and Rich Scene Prompt Editor |
| ⏩ | Existing-video continuation and optional source prepend |
| 🖼️ | Lossless PNG re-decode from saved scene latents |
| 🔬 | In-graph audio-seam diagnostics |

In the default `guide` mode, updated ComfyUI core owns guide placement and
reference-payload merging; this pack does not patch H3. The experimental
`masked_av` mode additionally needs per-stream H3 video/audio noise masks from
merged PR #15375. Current ComfyUI owns that path natively; older builds lazily
receive the vendored runtime compatibility only when that mode executes.

## Install

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/ethanfel/ComfyUI-MiniMaxH3-Contex-Loop.git
```

Restart ComfyUI and reload the browser. Release-versioned web-module imports
prevent older cached helpers from disabling the Plan editor after an update,
so clearing all browser data should not be necessary. An `ffmpeg` executable
on `PATH` is preferred, but review and final assembly can fall back to
ComfyUI's bundled PyAV when FFmpeg is missing or cannot launch.

Version 0.4 expects a ComfyUI build containing the native **Add Guide for
MiniMax H3** implementation from
[PR #15439](https://github.com/Comfy-Org/ComfyUI/pull/15439). Update ComfyUI
before starting a new v0.4 workflow.

NikoDemon80's upstream H3 Motion Context pack is optional and may be installed
alongside this one for its manual Motion Context, Save Latent, and Load Latent
nodes. H3-Multishot is also supported through guarded payload reuse.

## Choose a workflow

Start with the maintained v0.4 example for your generation mode:

- [T2V — Normal](<example_workflows/MiniMax H3 T2V - Normal.json>) or
  [Studio](<example_workflows/MiniMax H3 T2V - Studio.json>).
- [I2V — Normal](<example_workflows/MiniMax H3 I2V - Normal.json>) or
  [Studio](<example_workflows/MiniMax H3 I2V - Studio.json>).
- [FL2V — indexed A→B→A](<example_workflows/MiniMax H3 FL2V - Normal.json>).
- [Ref2V — Basic](<example_workflows/MiniMax H3 Ref2V - Basic.json>),
  [Tagged](<example_workflows/MiniMax H3 Ref2V - Tagged.json>), or
  [Studio Tagged](<example_workflows/MiniMax H3 Ref2V - Studio Tagged.json>).
  Use [Studio Tagged Source Audio](<example_workflows/MiniMax H3 Ref2V - Studio Tagged Source Audio.json>)
  for a fully wired `source_timeline` audio-reference example.
- [Sequential motion reference](<example_workflows/EXPERIMENTAL MiniMax H3 Ref2V - Sequential Motion.json>)
  remains explicitly experimental.

Normal workflows use the stable Plan and Scene Prompt Editor. Studio workflows
add the optional timeline-oriented Plan Studio and Rich Scene Prompt Editor.
See [all example workflows](example_workflows/README.md); retired v2 and
numeric-schedule examples remain available under `example_workflows/Archive/`.

## The loop

```text
Plan → Loop Start → Current Shot → H3 conditioning
                                      ↓
                               Contex Loop Context
                                      ↓
                           sample → decode → Loop Trim
                                      ↓
                     Segment + Checkpoint → Review Gate
                                      ↓
                                  Loop End ──↺

Loop End manifest → Assemble
```

For a first run:

1. Open an example and give the Plan a unique `run_name`.
2. Edit the scene prompts in the Plan or the large Scene Prompt Editor.
3. Choose an audio mode. For a prerecorded song, connect the same full track to
   Loop Start, Current Shot, and Assemble.
4. Queue the workflow. Review Gate pauses after every safely saved scene.
5. Approve, edit and retry, reroll the seed, or approve and stop.
6. Assemble the completed or partial manifest.

Existing output files are preserved. Assemble adds `_001`, `_002`, and so on
instead of overwriting an MP4 with the same requested name.

## Essential Plan settings

| Setting | Good starting point | Meaning |
|---|---:|---|
| `width × height` | `960 × 544` | Multiples of 32 |
| `continuation_mode` | `guide` | Default for scenes without an override; `guide` suits a new shot and `masked_av` an exact same-shot continuation |
| `context_length` | `22` guide / `39` masked | Repeated motion history carried into continuations |
| `encode_mode` | `video` | Preserves motion in the VAE latent |
| `anchor_mode` | `head` | Regenerates then trims the repeated opening context |
| `crop` | `disabled` | Best when source and target framing already agree |
| `default_duration_seconds` | `15` | Rounded up to H3's valid `17k+5` frame grid |
| `default_steps` | `20` | Override per scene when needed |
| `segment_crf` | `18–20` | Lower values produce larger, higher-quality checkpoints |

Use `generation_fingerprint` to record model, VAE, LoRA, references, CFG,
sampler, and scheduler choices that live outside the Plan. Change it when those
dependencies change so incompatible checkpoints cannot be resumed silently.

### Guide versus masked AV continuation

`guide` leaves the target latent noisy and supplies the previous scene as
fixed conditioning rows. H3 regenerates the repeated head, and Loop Trim
removes it. This remains the default.

Continuation mode can be overridden per scene in **Show advanced** without
adding another scene-card row. The choice describes the transition **into that
scene**: use `guide` for a new shot that should remember the preceding clip,
and `masked_av` when the same shot should continue seamlessly. Scene 1 uses
its choice only when Existing Video Context supplies a predecessor. In Plan
JSON, set `shots[n].continuation_mode`; omitting it inherits the Plan node.

The same Advanced group has per-scene **Context into scene** and **Audio
context** controls. Blank inherits the corresponding Plan default. Video `0`
starts a visually independent scene; a positive audio value can still carry
dialogue, ambience, or music into that new shot. Explicit audio `0` carries no
preceding generated sound. For scene 1, these control Existing Video Context;
a zero-video-context imported original can still be prepended during assembly.
Independent audio context applies to guide mode with generated-audio continuity.
Masked AV always keeps its audio and video prefix lengths synchronized, while
`source_track` continues to use its exact timeline slice.

`masked_av` writes the previous scene's decoded video tail into the beginning
of the current target video latent, copies the matching tail from the previous
sampled audio latent, and protects both streams with `0 = preserve`,
`1 = generate` denoise masks. Wire the new **Chain Context latent** output to
the sampler's `latent_image`; the output passes the original target through on
scene 1 and in `guide` mode, so that one wire supports both modes.

Masked continuation requires `encode_mode=video`, `anchor_mode=head`, and at
least 5 context frames, on a ComfyUI build with native PR #15439 guide/MultiRef
support. Use **39 frames** for comparisons: at 24 fps it is
exactly 1.625 seconds and exactly 65 audio-latent steps at H3's 40 Hz audio
grid. A per-scene override participates in the Plan/history hashes from that
scene onward, so a checkpoint cannot silently resume under the wrong method.
When modes are mixed, use settings compatible with masked AV for the whole
Plan—normally `context_length=39`, `encode_mode=video`, and `anchor_mode=head`.

## Audio at a glance

| Mode | Use it when |
|---|---|
| `source_track` | A finished song or spoken performance must remain exact in the final video. |
| `generated_audio` | H3 should generate new speech, ambience, effects, or music. |
| `source_plus_timeline` | You intentionally want both the source slice and generated-audio history; experimental. |

For a 362-frame source-audio reference, Current Shot's experimental
`align_audio_reference` switch trims only the Ref2VA slice to **15.070 s**. It
keeps 603 H3 audio steps with a short padded tail and does not modify the full
track used for final assembly.

See [Audio and continuity](docs/AUDIO_AND_CONTINUITY.md) for wiring, generated
WAV preservation, timing behavior, and the Seam Probe.

## Prompt-driven references at a glance

```text
Load Image ─→ Tagged Picture Ref ─┐
24 fps IMAGE (+ paired AUDIO) ─→ Tagged Video Ref ─┐
Standalone AUDIO ─→ Tagged Audio Ref ──────────────┴→ Tagged Ref2VA

Current Shot prompt / scene / dimensions / length ───────────────────↗
Current Shot state ──────────────────────────────────────────────────↗
```

Register stable aliases such as `@hero`, `@performance`, and `@voice`, then
mention only the media needed by each scene. Tagged Ref2VA activates those
sources and compiles their aliases to compact native `<Picture N>`, `<Video N>`,
and `<Audio N>` labels. It does not insert subject definitions or other prompt
text; the user remains responsible for the complete H3 prompt.

For a song or other full source track, set Tagged Audio Ref to
`source_timeline`, keep the full loader AUDIO connected to that node, and wire
Current Shot `state` to Tagged Ref2VA. Tagged Ref2VA then derives the exact
scene-local audio window internally. Do not connect `source_audio_slice` to the
Tagged Audio Ref: returning that node's fingerprint to Plan would make a graph
cycle. The
[Studio Tagged Source Audio example](<example_workflows/MiniMax H3 Ref2V - Studio Tagged Source Audio.json>)
shows the full loader fan-out, `@audio_1` activation, source-track Plan mode,
H3-grid alignment, assembly, recovery, and Run Manager asset binding.

The original numeric-range nodes remain available in the **legacy schedule**
category when explicit selectors are useful.

## Legacy scheduled references

```text
Load Image ─→ Scheduled Picture Ref ─┐
24 fps IMAGE (+ paired AUDIO) ─→ Scheduled Video Ref ─┐
Standalone AUDIO ─→ Scheduled Audio Ref ──────────────┴→ Scheduled Ref2VA

Current Shot prompt / scene / dimensions / length ───────────────────────↗
```

Stable aliases such as `@hero`, `@performance`, and `@voice` are optional. The
scheduler resolves active aliases to native `<Picture N>`, `<Video N>`, and
`<Audio N>` labels for each scene. It never writes semantic prompt definitions
for you.

The compliance control has three levels:

| Policy | Behavior |
|---|---|
| `strict` | Compile valid aliases and stop on scheduler mistakes. |
| `soft` | Compile valid aliases, warn about unresolved prompt tags, and continue. |
| `disabled` | Pass prompt text unchanged and make scheduler-owned checks non-blocking. |

See [Scheduled references](docs/SCHEDULED_REFERENCES.md) for selectors, native
numbering, hover previews, fingerprints, and patch priority.

## Review, resume, and restore

Review Gate owns retries after a scene has been saved. During sampling, the
optional floating **Cancel & reroll scene N** action cancels only the active H3
prompt, writes a new scene seed, and requeues from that checkpoint position.
During review, a prompt editor bound to the same Plan follows the active scene
and supplies the live prompt for retry or reroll; the Gate field remains an
explicit fallback.

To resume manually, keep the same `run_name`, set `start_clip` to the desired
scene, and retain the same dependencies. A bounded `scene_range` accepts one
scene (`3`) or one continuous range (`3:8`).

Checkpoint Manager identifies saved takes by scene and inferred branch,
previews their media and exact video/audio dependencies, and safely deletes
inactive leaves one revision at a time. Run Manager restores archived prompts
and Plan settings and can archive loader-backed image/audio/video assets under
the run folder. See
[Runs, review, and recovery](docs/RUNS_AND_RECOVERY.md).

## Documentation

- [Documentation index](docs/README.md) — choose a focused guide by task.
- [Prompt and timing guide](H3_CHAIN_FORMAT_GUIDE.md) — complete Plan JSON and
  node-setting reference.
- [Scene authoring](docs/SCENE_AUTHORING.md) — Plan editor, Prompt Editor,
  revisions, seeds, and bounded ranges.
- [Scheduled references](docs/SCHEDULED_REFERENCES.md) — tags, selectors,
  numbering, previews, compliance, and fingerprints.
- [Audio and continuity](docs/AUDIO_AND_CONTINUITY.md) — audio modes, 15.070 s
  reference alignment, generated WAVs, trimming, and seam diagnostics.
- [Runs, review, and recovery](docs/RUNS_AND_RECOVERY.md) — Review Gate,
  Checkpoint Manager, Run Manager assets, partial output, and PNG export.
- [Advanced workflows](docs/ADVANCED_WORKFLOWS.md) — existing-video extension,
  long context, last-frame targets, and performance re-filming.
- [Compatibility](docs/COMPATIBILITY.md) — patch ownership, native guides,
  SolAttn, H3-Multishot, and frontend workarounds.
- [Example workflow notes](example_workflows/README.md)
- [Changelog](CHANGELOG.md)
- [Third-party credits](THIRD_PARTY_NOTICES.md)

## Project history and credits

This project began with **NikoDemon80's**
[H3 Motion Context](https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context)
and grew into a separate production-loop pack so both projects could remain
clear and coexist. The Ref2VA multi-reference/audio fix and first global-ref
demo were contributed by **seitanism**. The editor's quick reference/dialogue
interactions were inspired by **nkxx188's**
[ComfyUI-MiniMaxH3-Easy](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy).

Full attribution is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

GPL-3.0. See [LICENSE](LICENSE).
