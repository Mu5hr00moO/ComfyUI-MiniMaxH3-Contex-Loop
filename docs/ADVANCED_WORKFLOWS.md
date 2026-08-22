# Advanced workflows

## Extend an existing video

Use **MiniMax H3 Existing Video Context** when scene 1 must continue a decoded
video rather than start from an empty timeline. The complete experimental model
is [MiniMax H3 Extend Existing Video Model Workflow](<../example_workflows/MiniMax H3 Extend Existing Video Model Workflow.json>).

```text
Plan ────────────────────────────────┐
Core Load Video (VIDEO) ─────────────┼→ Existing Video Context → Loop Start
Other loader IMAGE + AUDIO + FPS ────┘
H3 audio VAE ─────────────────────────────────────────────→ Loop Context
```

Use exactly one video route:

- `source_video` accepts native ComfyUI VIDEO, including embedded audio and
  exact FPS. An explicit audio input overrides embedded audio.
- `source_frames` accepts IMAGE from VHS or another decoder. Connect optional
  AUDIO and set the real decoded `source_fps`.

The adapter normalizes frames to the Plan canvas and H3's 24 fps, uses the last
`context_length` frames as scene 1's predecessor, and can persist the normalized
source as a prelude. In head mode:

```text
scene 1 delivered frames = raw frames - imported context frames
```

Connect the audio VAE to Loop Context for imported-audio timeline guidance in
`generated_audio` or `source_plus_timeline`. Visual continuation still works
without imported audio.

With `prepend_original=true`, Assemble places the normalized original before
generated scenes, including partial output. Arbitrary source codecs and frame
rates cannot be stream-concatenated safely, so the prelude is encoded once at
the Plan's `segment_crf`; generated H.264 segments remain stream-copied.

The imported tail is fingerprinted. Reconnect the same Plan and source when
resuming; a changed source correctly invalidates dependent checkpoints.

Recommended first settings:

```text
context_length       22
encode_mode          video
anchor_mode          head
audio_context_length 22
Loop Trim match_tail true
Spectrum             off
```

## Long visual context

`56` is a valid advanced context length. It carries 2.33 seconds of motion in
17 video latent steps, but head mode regenerates and removes all 56 frames from
every continuation. Start with `22`; use `56` when a long clip's camera move or
performance genuinely needs more history.

## Last-frame destinations

When stock H3 Image to Video supplies `last_frame`, Motion Context preserves
that target on continuation scenes. The carried repeated head replaces a
conflicting `first_frame` anchor because both cannot own the same opening
coordinates.

Place official **MiniMax H3 Add Guide** nodes after Loop Context for additional
scene-local image, video, or audio anchors.

## Scene-local Guide Image anchors

Use **MiniMax H3 Guide Image** when image anchors must be authored against the
scene plan rather than a single generated clip. Chain as many Guide Image nodes
as needed into **MiniMax H3 Guide Images to Video**.

For chain use, wire Current Shot's `prompt`, RAW `length`, `width`, `height`, and
`state` into Guide Images to Video, together with the same H3 `clip` and video
`vae` used for conditioning. The `length` input must be Current Shot's RAW frame
count: scene-aware execution rejects a generated frame count that does not match
the current shot's `raw_frames`. Feed Guide Images to Video's `positive` and
`latent` outputs into Chain Context's `conditioning` and `latent` inputs, then
use Chain Context's outputs for the sampler path.

Scene-aware rules are strict:

- every guide sets a one-based `scene_index`;
- scene 1 has an explicit visible frame `0`;
- every non-final scene has a visible frame `-1`;
- scene N inherits scene N−1 frame `-1` as its visible frame `0`, so later
  scenes must not define another explicit frame `0`;
- non-negative indices and `-1` are interpreted on the **visible delivered
  timeline**, then shifted behind that scene's raw continuation prefix.

The node rejects duplicate scene/frame targets and out-of-range visible indices.
In standalone use without Chain state, indices address the generated clip
directly and negative values count from its end. In `latent_guide`, an inherited
start image remains a prompt image and is also anchored at the last preserved
raw-prefix frame so prefix cleanup does not discard that boundary condition.

## Re-film a synchronized performance

The [three-angle guitar workflow](<../example_workflows/EXPERIMENTAL MiniMax H3 Three-Angle Guitar Ref2VA.json>)
uses **Reference Video Prep** to convert native VIDEO or decoded IMAGE/AUDIO
into exact 24 fps Ref2VA input. Its soundtrack is copied without padding or
time-stretching, allowing one performance to be generated from multiple camera
angles in one pass.

Reference Video Prep rejects sources shorter than the requested H3-valid length
instead of silently padding or stretching them.

## External stitchers

Loop Trim's `retain_overlap_frames` output exposes part of the repeated visual
context while leaving its normal images and audio fully trimmed. Use it when an
external optical-flow or learned stitcher benefits from overlap. Keep it at `0`
for the standard hard-boundary chain.

## Full-segment seam diagnostics

**MiniMax H3 Contex Loop Full Segment Save** is an opt-in replacement for the
normal Segment + Checkpoint saver when you need to inspect what H3 decoded on
both sides of Loop Trim. Wire its ordinary `images` input from the normal
post-Trim output and wire `images_before_trim` directly from the current VAE
Decode output before Loop Trim. The pre-Trim batch must contain exactly the
scene's planned `raw_frames`.

The node calls the standard saver for delivered video, checkpoints, revisions,
audio, blend artifacts, and the segment record consumed by Review Gate and Loop
End. It then writes one additional revision-versioned MP4 under:

```text
output/h3_chains/<run_name>/full_segments/
```

That MP4 includes the repeated leading context when one is present and is for
visual seam diagnosis only. Normal final/partial assembly continues to use the
delivered segment.
