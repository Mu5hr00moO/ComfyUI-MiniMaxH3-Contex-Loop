# Scene authoring

## Plan structure

The Plan node provides a visual editor and stores ordinary JSON underneath.
Put shared instructions in `prompt_prefix`; each scene should describe what
changes.

```json
{
  "prompt_prefix": "Keep the same performer, wardrobe and visual language.",
  "defaults": {"duration_seconds": 15, "steps": 20},
  "shots": [
    {"id": "intro", "prompt": "Instrumental opening in the elevator.", "seed": 123},
    {"id": "street", "prompt": "Continue outside into the rain.", "seed": 456}
  ]
}
```

Prompts may be multiline strings or arrays of lines. Seconds are rounded up to
H3's valid `17k+5` frame grid. Use `length` when exact raw frames matter.

The [complete format guide](../H3_CHAIN_FORMAT_GUIDE.md) documents every Plan
and per-scene field, raw versus delivered length, prompt structure, seeds, and
timing.

## Per-scene continuation

The Plan node's `continuation_mode` is the inherited default. Under **Show
advanced**, a scene may override the transition **into that scene**:

| Mode | Editor label | Operator meaning |
|---|---|---|
| `guide` | Guide · new shot | Re-encode decoded predecessor frames as conditioning and let H3 regenerate the repeated head. |
| `latent_guide` | Latent Guide · raw latent | For generated predecessors, copy the previous sampler's raw AV latent tail directly into the next target and preserve it with AV masks. |
| `masked_av` | Masked AV · same shot | VAE-encode the preceding decoded video tail into a preserved target prefix and pair it with the sampled audio tail. |

`latent_guide` and `masked_av` require `encode_mode=video`,
`anchor_mode=head`, and at least 5 context frames. Their video/audio prefix is
one physical interval; the independent `audio_context_length` override applies
only to `guide`. Scene 1 uses its continuation choice only when **Existing
Video Context** supplies a predecessor. Because an imported video has no H3
sampled predecessor latent, scene-1 `latent_guide` deliberately uses the masked
decoded-frame VAE fallback.

Set `shots[n].continuation_mode` in raw Plan JSON to persist an override. Omit
it to inherit the Plan node. A changed mode participates in checkpoint/history
compatibility from that scene onward.

## Scene Prompt Editor

Connect Plan to **MiniMax H3 Scene Prompt Editor** for a large synchronized
textarea. It edits the selected scene's real `shots[n].prompt`; there is no
second prompt copy.

- Arrow buttons or `Alt+Left/Right` change scenes.
- `@` opens Picture/Video/Audio references.
- `#` opens dialogue helpers.
- `A−` and `A+` change persistent type size.
- The node may sit inline before Loop Start or on an editor-only branch.

The reference tray discovers downstream Scheduled Ref2VA, core Ref2VA, and core
Image to Video nodes without introducing an execution socket or graph cycle.
Hovering a loader-backed reference previews its image, video, or audio; computed
tensors remain usable even when no browser-playable source file can be found.

## Prompt revisions

The compact `‹ current / total ›` selector below the editor navigates prompt
history. Typing updates one draft rather than creating a revision per keystroke.
When Current Shot executes, that exact prompt becomes immutable; editing it
creates a child revision.

History is stored outside Plan JSON and loaded only for the selected scene:

```text
output/h3_chains/<run_name>/prompt_history/<scene_id>/
```

The Plan retains only the active prompt, keeping workflow JSON readable and
load time independent of old revisions.

## Seeds and bounded runs

Set a scene seed explicitly when repeatability matters. If omitted, Plan derives
a deterministic seed from `base_seed` and scene identity.

Loop Start's `scene_range` accepts one continuous selection:

| Value | Result |
|---|---|
| blank | `start_clip` through the end |
| `3` | scene 3 only |
| `3:8` | scenes 3 through 8, inclusive |

A range starting above scene 1 requires the preceding checkpoint. Disjoint
selections are rejected because skipped scenes would break the motion chain.

## Prompt Assistant status

The embedded Prompt Assistant is currently dormant so the editor retains its
compact manual workflow. Use the `comfyui-mcp` sidebar Agent panel for Codex or
Hermes assistance. The implementation, safety model, and future console-agent
design are preserved in the
[Prompt Assistant study](../AGENT_PROMPT_ASSISTANT_STUDY.md).
