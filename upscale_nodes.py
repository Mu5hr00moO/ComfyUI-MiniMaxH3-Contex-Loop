"""Deferred, checkpoint-backed upscale loops for MiniMax H3 chains.

The source generation remains immutable.  A completed active checkpoint branch
is adapted into a second recursive graph whose body may contain any upscaler
(native H3 latent refinement, LTX video-to-video, or a custom image pipeline).
Each delivered HQ scene is persisted below the source run's ``upscaled``
folder before the loop advances, and the final merger reuses the original
audio contract without requiring the source video segments.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from . import chain_nodes as chain

try:
    from comfy.nested_tensor import NestedTensor as _ComfyNestedTensor
except ImportError:
    _ComfyNestedTensor = None


UPSCALE_FLOW_TYPE = "H3_CHAIN_UPSCALE_FLOW"
UPSCALE_STATE_TYPE = "H3_CHAIN_UPSCALE_STATE"
UPSCALE_SEGMENT_TYPE = "H3_CHAIN_UPSCALE_SEGMENT"
UPSCALE_MANIFEST_TYPE = "H3_CHAIN_UPSCALE_MANIFEST"
UPSCALE_BACKENDS = ("h3_latent", "ltx_2_5", "custom")


def _profile_dir(run_name: str, profile: str) -> str:
    run = chain._safe_name(run_name, "h3_chain")
    name = chain._safe_name(profile, "upscale")
    path = os.path.abspath(os.path.join(
        chain._output_root(), "h3_chains", run, "upscaled", name))
    root = os.path.abspath(chain._output_root())
    if os.path.commonpath([root, path]) != root:
        raise ValueError("H3 upscale profile path escapes the output directory.")
    return path


def _profile_paths(run_name: str, profile: str, index: int) -> dict[str, str]:
    root = _profile_dir(run_name, profile)
    stem = "clip_%04d" % int(index)
    return {
        "root": root,
        "segment": os.path.join(root, "segments", stem + ".mp4"),
        "checkpoint": os.path.join(root, "checkpoints", stem + ".safetensors"),
        "metadata": os.path.join(root, "checkpoints", stem + ".json"),
        "prompt": os.path.join(root, "prompts", stem + ".txt"),
        "audio": os.path.join(root, "audio", stem + ".wav"),
        "manifest": os.path.join(root, "upscale_manifest.json"),
        "partial": os.path.join(
            root, "partial", "through_clip_%04d.manifest.json" % int(index)),
        "final": os.path.join(root, "final"),
    }


def _parse_recipe(value: str) -> dict[str, Any]:
    text = str(value or "").strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("Upscale recipe_json must contain valid JSON.") from exc
    if not isinstance(parsed, dict):
        raise ValueError("Upscale recipe_json must contain a JSON object.")
    return parsed


def _profile_config(backend: str, recipe_json: str, save_latent: bool,
                    segment_crf: int) -> dict[str, Any]:
    if backend not in UPSCALE_BACKENDS:
        raise ValueError("Unknown H3 upscale backend %r." % backend)
    recipe = _parse_recipe(recipe_json)
    value = {
        "backend": backend,
        "recipe": recipe,
        "save_latent": bool(save_latent),
        "segment_crf": int(segment_crf),
    }
    value["config_hash"] = chain._fingerprint(value)
    return value


def _source_manifest(plan: dict[str, Any]) -> dict[str, Any]:
    completed = chain._load_resume_state(plan, len(plan["shots"]) + 1)
    manifest = chain._manifest_from_state(completed)
    if isinstance(manifest.get("prelude"), dict):
        raise ValueError(
            "Deferred upscale does not yet support an existing-video prelude. "
            "Upscale the prelude separately or use a chain without prepend_original.")
    return manifest


def _source_hash(manifest: dict[str, Any]) -> str:
    return chain._fingerprint(manifest)


def _public_upscale_segment(value: dict[str, Any]) -> dict[str, Any]:
    private = {"_h3_upscale_decision"}
    return {
        key: item for key, item in value.items()
        if not key.startswith("_") and key not in private
    }


def _source_segment(state: dict[str, Any], index: int | None = None
                    ) -> dict[str, Any]:
    slot = int(state["index"] if index is None else index)
    segments = state["source_manifest"].get("segments") or []
    if slot < 1 or slot > len(segments):
        raise ValueError("Upscale scene must be between 1 and %d." % len(segments))
    source = segments[slot - 1]
    if int(source.get("index", -1)) != slot:
        raise ValueError("Source manifest scene indexes are not contiguous.")
    return source


def _load_source_tensors(source: dict[str, Any]) -> dict[str, Any]:
    if chain._st_load is None:
        raise RuntimeError("safetensors is required for deferred H3 upscaling.")
    checkpoint = chain._absolute_output_path(source["checkpoint"])
    expected = str(source.get("checkpoint_sha256") or "")
    if not os.path.isfile(checkpoint):
        raise FileNotFoundError("Source H3 checkpoint is missing: %s" % checkpoint)
    if not expected or chain._file_sha256(checkpoint) != expected:
        raise ValueError("Source H3 checkpoint failed its SHA-256 integrity check.")
    return chain._st_load(checkpoint)


def _source_latent(tensors: dict[str, Any]) -> tuple[dict[str, Any], str]:
    if "denoised_video" in tensors:
        video_key = "denoised_video"
        audio_key = "denoised_audio" if "denoised_audio" in tensors else "audio"
        route = "saved denoised x0"
    else:
        video_key = "video"
        audio_key = "audio"
        route = "terminal sampler output"
    missing = [key for key in (video_key, audio_key) if key not in tensors]
    if missing:
        raise ValueError("Source H3 checkpoint is missing tensors: %s" % missing)
    return ({"samples": _packed_samples(
        [tensors[video_key], tensors[audio_key]])}, route)


def _packed_samples(streams: list[Any]) -> Any:
    if len(streams) == 1:
        return streams[0]
    if _ComfyNestedTensor is not None:
        return _ComfyNestedTensor(streams)
    return streams


def _cpu_latent(latent: dict[str, Any] | None) -> dict[str, Any] | None:
    if latent is None:
        return None
    samples = latent.get("samples") if isinstance(latent, dict) else None
    if samples is None:
        raise ValueError("Upscale latent has no samples value.")
    streams = chain._streams_from_latent(latent)
    copied = [chain._tensor_cpu_clone(item) for item in streams]
    return {"samples": _packed_samples(copied)}


def _latent_checkpoint_tensors(latent: dict[str, Any]) -> tuple[dict[str, Any], str]:
    streams = chain._streams_from_latent(latent)
    if not streams:
        raise ValueError("Upscale latent contains no tensor streams.")
    if len(streams) == 2:
        return ({
            "upscaled_video": chain._tensor_cpu_clone(streams[0]),
            "upscaled_audio": chain._tensor_cpu_clone(streams[1]),
        }, "joint_av")
    if len(streams) == 1:
        return ({"upscaled_samples": chain._tensor_cpu_clone(streams[0])},
                "single")
    return ({"upscaled_stream_%d" % index: chain._tensor_cpu_clone(value)
             for index, value in enumerate(streams)}, "multi")


def _load_upscale_prefix(state: dict[str, Any], start_clip: int
                         ) -> list[dict[str, Any]]:
    values = []
    for index in range(1, int(start_clip)):
        paths = _profile_paths(state["run_name"], state["profile"], index)
        if not os.path.isfile(paths["metadata"]):
            raise FileNotFoundError(
                "Cannot resume upscale scene %d: scene %d metadata is missing: %s"
                % (start_clip, index, paths["metadata"]))
        metadata = chain._read_json(paths["metadata"])
        if metadata.get("format") != "h3_chain_upscale_segment_v1":
            raise ValueError("Upscale scene %d metadata has an unknown format." % index)
        if metadata.get("source_manifest_hash") != state["source_manifest_hash"]:
            raise ValueError("Upscale scene %d belongs to a different source branch." % index)
        if metadata.get("profile_config_hash") != state["profile_config"]["config_hash"]:
            raise ValueError("Upscale scene %d used different profile settings." % index)
        segment = metadata.get("segment")
        if not isinstance(segment, dict):
            raise ValueError("Upscale scene %d metadata has no segment." % index)
        _verify_upscale_segment(segment, index)
        source = _source_segment(state, index)
        if (segment.get("source_revision") != source.get("revision") or
                segment.get("source_checkpoint_sha256") !=
                source.get("checkpoint_sha256")):
            raise ValueError("Upscale scene %d points to a different source revision." % index)
        values.append(_public_upscale_segment(segment))
    return values


def _verify_upscale_segment(segment: dict[str, Any], index: int) -> None:
    if int(segment.get("index", -1)) != int(index):
        raise ValueError("Upscale segment slot %d has the wrong scene index." % index)
    for key, hash_key in (("segment", "segment_sha256"),
                          ("checkpoint", "checkpoint_sha256")):
        value = segment.get(key)
        expected = str(segment.get(hash_key) or "")
        if not isinstance(value, str) or not expected:
            raise ValueError("Upscale scene %d has no verified %s." % (index, key))
        path = chain._absolute_output_path(value)
        if not os.path.isfile(path):
            raise FileNotFoundError("Upscale scene %d %s is missing: %s" %
                                    (index, key, path))
        if chain._file_sha256(path) != expected:
            raise ValueError("Upscale scene %d %s failed SHA-256 verification." %
                             (index, key))
    audio = segment.get("generated_audio")
    if audio is not None:
        expected = str(segment.get("generated_audio_sha256") or "")
        path = chain._absolute_output_path(audio)
        if not expected or not os.path.isfile(path) or chain._file_sha256(path) != expected:
            raise ValueError("Upscale scene %d generated audio is invalid." % index)


def _upscale_manifest(state: dict[str, Any], segments: list[dict[str, Any]],
                      complete: bool) -> dict[str, Any]:
    source = state["source_manifest"]
    total = len(source["segments"])
    indexes = [int(item.get("index", -1)) for item in segments]
    if indexes != list(range(1, len(segments) + 1)):
        raise ValueError("Upscale manifest segments must be contiguous from scene 1.")
    manifest = {
        "format": ("h3_chain_upscale_manifest_v1" if complete else
                   "h3_chain_upscale_partial_manifest_v1"),
        "run_name": state["run_name"],
        "profile": state["profile"],
        "profile_config": state["profile_config"],
        "source_manifest_hash": state["source_manifest_hash"],
        "source_plan_hash": source.get("plan_hash"),
        "source_manifest": source,
        "clip_count": total,
        "completed_clip_count": len(segments),
        "total_delivered_frames": sum(
            int(item.get("delivered_frames", 0)) for item in segments),
        "duration_seconds": sum(
            int(item.get("delivered_frames", 0)) for item in segments) /
            float(chain.FPS),
        "segments": [_public_upscale_segment(item) for item in segments],
        "latent_saving": bool(state["profile_config"]["save_latent"]),
    }
    if complete and len(segments) != total:
        raise ValueError("A complete upscale manifest requires %d scenes." % total)
    if not complete:
        manifest["planned_clip_count"] = total
        manifest["last_completed_clip"] = len(segments)
    return manifest


class MiniMaxH3ChainUpscaleAdapter:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "plan": (chain.PLAN_TYPE, {
                    "tooltip": "Plan passed through Checkpoint Manager after the "
                               "desired complete branch is made active."}),
                "profile": ("STRING", {
                    "default": "h3_2x",
                    "tooltip": "Child output folder under this run's upscaled directory."}),
                "backend": (list(UPSCALE_BACKENDS), {
                    "default": "h3_latent",
                    "tooltip": "Provenance label for this child recipe. It does "
                               "not constrain which nodes you place in the loop."}),
                "recipe_json": ("STRING", {
                    "default": "{}", "multiline": True,
                    "tooltip": "Provenance-only backend/model/sigma settings. "
                               "The visible graph remains authoritative."}),
                "start_clip": ("INT", {
                    "default": 1, "min": 1, "max": chain.MAX_SHOTS,
                    "tooltip": "First upscale scene. Values above 1 verify and "
                               "reuse the saved HQ prefix for this profile."}),
                "end_clip": ("INT", {
                    "default": 0, "min": 0, "max": chain.MAX_SHOTS,
                    "tooltip": "Last scene to upscale; 0 means the final source scene."}),
                "save_latent": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Persist the HQ sampler latent in each child "
                               "checkpoint. Off still saves a tiny assembly/audio "
                               "checkpoint for standalone merge and resume."}),
                "segment_crf": ("INT", {
                    "default": 18, "min": 0, "max": 51,
                    "tooltip": "H.264 quality for persisted HQ scene segments."}),
            },
            "optional": {
                "source_audio": ("AUDIO", {
                    "tooltip": "Same source track used by source_track plans; "
                               "validates the selected parent branch."}),
                "external_context": (chain.EXTERNAL_CONTEXT_TYPE, {
                    "tooltip": "Same imported context used by the parent chain."}),
            },
            "hidden": {"initial_state": (UPSCALE_STATE_TYPE,)},
        }

    RETURN_TYPES = (UPSCALE_FLOW_TYPE, UPSCALE_STATE_TYPE,
                    chain.MANIFEST_TYPE, "STRING")
    RETURN_NAMES = ("flow", "state", "source_manifest", "status")
    OUTPUT_TOOLTIPS = (
        "Raw recursive-loop link; connect it directly to Upscale Loop End.",
        "Current child-run state for Upscale Current Scene.",
        "Verified complete manifest of the selected parent checkpoint branch.",
        "Selected profile, scene range, backend label, and latent-save policy.",
    )
    FUNCTION = "adapt"
    CATEGORY = "conditioning/minimax/contex_loop/upscale"
    DESCRIPTION = ("Turn the complete active checkpoint branch into a resumable "
                   "child upscale loop without modifying the source run.")

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return float("NaN")

    def adapt(self, plan, profile, backend, recipe_json, start_clip, end_clip,
              save_latent, segment_crf, source_audio=None,
              external_context=None, initial_state=None):
        if initial_state is None:
            prepared = chain._plan_with_external_context(plan, external_context)
            prepared = chain._plan_with_source_audio(prepared, source_audio)
            manifest = _source_manifest(prepared)
            total = len(manifest["segments"])
            start = int(start_clip)
            stop = total if int(end_clip) == 0 else int(end_clip)
            if start < 1 or start > total:
                raise ValueError("start_clip must be between 1 and %d." % total)
            if stop < start or stop > total:
                raise ValueError("end_clip must be between start_clip and %d." % total)
            state = {
                "run_name": str(manifest["run_name"]),
                "profile": chain._safe_name(profile, "upscale"),
                "profile_config": _profile_config(
                    backend, recipe_json, save_latent, segment_crf),
                "source_manifest": manifest,
                "source_manifest_hash": _source_hash(manifest),
                "index": start,
                "range_start": start,
                "end_clip": stop,
                "segments": [],
                "previous_frames": None,
                "previous_latent": None,
            }
            state["segments"] = _load_upscale_prefix(state, start)
        else:
            state = dict(initial_state)
            manifest = state["source_manifest"]
            if str(manifest.get("plan_hash")) != str(plan.get("plan_hash")):
                raise ValueError("Source H3 plan changed during upscale recursion.")
        status = ("upscale %s scene %d/%d; range %d:%d; backend=%s; HQ latent %s" %
                  (state["profile"], int(state["index"]),
                   len(state["source_manifest"]["segments"]),
                   int(state["range_start"]), int(state["end_clip"]),
                   state["profile_config"]["backend"],
                   "saved" if state["profile_config"]["save_latent"]
                   else "not saved"))
        return ("h3_upscale", state, manifest, status)


class MiniMaxH3ChainUpscaleCurrent:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"state": (UPSCALE_STATE_TYPE, {
            "tooltip": "Current child-run state from Upscale Adapter."})}}

    RETURN_TYPES = (UPSCALE_STATE_TYPE, "LATENT", "LATENT", "LATENT", "INT",
                    "INT", "STRING", "INT", "INT", "INT", "INT", "INT",
                    "INT", "AUDIO", "IMAGE", "LATENT", "STRING")
    RETURN_NAMES = ("state", "source_latent", "source_video_latent",
                    "source_audio_latent", "clip_index", "clip_count", "prompt",
                    "width", "height", "seed", "trim_frames", "raw_frames",
                    "delivered_frames", "source_audio",
                    "previous_upscaled_frames", "previous_upscaled_latent",
                    "status")
    OUTPUT_TOOLTIPS = (
        "Unchanged current child-run state for Segment Save and Loop End.",
        "Verified joint H3 video/audio x0 for combined learned upscalers.",
        "Verified 24-channel H3 video x0 for video-only upscalers.",
        "Original H3 audio latent to preserve when recombining a refined video.",
        "One-based source scene index.",
        "Total scene count in the selected parent branch.",
        "Exact saved prompt for this source scene.",
        "Parent generation width used to rebuild H3 pass-2 conditioning.",
        "Parent generation height used to rebuild H3 pass-2 conditioning.",
        "Saved parent scene seed, suitable for deterministic pass-2 noise.",
        "Repeated raw head frames that Segment Save removes after refinement.",
        "Expected raw frame count before the repeated head is removed.",
        "Expected delivered frame count after trimming.",
        "Decoded delivered parent audio, when the checkpoint contains it.",
        "Prior scene's delivered HQ context frames for backend continuity.",
        "Prior scene's transient HQ latent, when Loop End received one.",
        "Source scene, selected x0 route, and exact frame contract.",
    )
    FUNCTION = "current"
    CATEGORY = "conditioning/minimax/contex_loop/upscale"
    DESCRIPTION = ("Verify and load one source scene checkpoint lazily for an "
                   "H3, LTX, or custom upscale body.")

    def current(self, state):
        index = int(state["index"])
        source = _source_segment(state)
        tensors = _load_source_tensors(source)
        latent, route = _source_latent(tensors)
        video_stream, audio_stream = chain._streams_from_latent(latent)
        video_latent = {"samples": video_stream}
        audio_latent = {"samples": audio_stream}
        audio = None
        if "delivered_audio" in tensors:
            sample_rate = int(source.get("sample_rate", 0))
            if sample_rate < 1:
                raise ValueError("Source scene %d has audio but no sample rate." % index)
            audio = {"waveform": tensors["delivered_audio"],
                     "sample_rate": sample_rate}
        raw = int(source["raw_frames"])
        delivered = int(source["delivered_frames"])
        trim = raw - delivered
        compatibility = state["source_manifest"].get("compatibility") or {}
        width = int(compatibility.get("width", 0))
        height = int(compatibility.get("height", 0))
        if width < 1 or height < 1:
            raise ValueError("Source H3 manifest has no valid canvas dimensions.")
        seed = int(source.get("seed", 0))
        status = ("upscale source scene %d/%d: %s; raw=%df delivered=%df trim=%df" %
                  (index, len(state["source_manifest"]["segments"]), route,
                   raw, delivered, trim))
        return (state, latent, video_latent, audio_latent, index,
                len(state["source_manifest"]["segments"]),
                str(source.get("prompt") or ""), width, height, seed, trim,
                raw, delivered, audio, state.get("previous_frames"),
                state.get("previous_latent"), status)


class MiniMaxH3ChainUpscaleSegmentSave:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "state": (UPSCALE_STATE_TYPE, {
                    "tooltip": "Current child-run state from Upscale Current Scene."}),
                "images": ("IMAGE", {
                    "tooltip": "Decoded HQ RAW scene frames, including the source "
                               "scene's repeated head. This node trims it exactly."}),
            },
            "optional": {
                "upscaled_latent": ("LATENT", {
                    "tooltip": "Final HQ latent. Required only when the Adapter's "
                               "save_latent option is enabled."}),
            },
        }

    RETURN_TYPES = (UPSCALE_SEGMENT_TYPE, "STRING")
    RETURN_NAMES = ("segment", "status")
    OUTPUT_TOOLTIPS = (
        "Verified HQ scene record for Upscale Loop End.",
        "Saved scene path, dimensions, and HQ latent persistence result.",
    )
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "conditioning/minimax/contex_loop/upscale"
    DESCRIPTION = ("Persist one trimmed HQ scene plus a self-contained assembly "
                   "checkpoint; optionally retain its large HQ latent.")

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return float("NaN")

    def save(self, state, images, upscaled_latent=None):
        if chain._st_save is None or chain.torch is None:
            raise RuntimeError("safetensors and torch are required for H3 upscale saves.")
        index = int(state["index"])
        source = _source_segment(state)
        raw = int(source["raw_frames"])
        delivered = int(source["delivered_frames"])
        trim = raw - delivered
        if int(images.shape[0]) != raw:
            raise ValueError(
                "Upscale scene %d decoded %d frames; expected %d RAW frames "
                "before trimming %d repeated frames." %
                (index, int(images.shape[0]), raw, trim))
        delivered_images = images[trim:trim + delivered]
        height = int(delivered_images.shape[1])
        width = int(delivered_images.shape[2])
        existing = state["segments"]
        if existing:
            first = existing[0]
            if (int(first.get("width", width)) != width or
                    int(first.get("height", height)) != height):
                raise ValueError(
                    "Upscale scene %d is %dx%d; profile scene 1 is %dx%d." %
                    (index, width, height, int(first["width"]), int(first["height"])))

        save_latent = bool(state["profile_config"]["save_latent"])
        if save_latent and upscaled_latent is None:
            raise ValueError(
                "Upscale profile enables save_latent, but scene %d received no HQ latent."
                % index)
        source_tensors = _load_source_tensors(source)
        tensors = {"upscale_marker": chain.torch.tensor([index])}
        sample_rate = int(source.get("sample_rate", 0))
        if "delivered_audio" in source_tensors:
            tensors["delivered_audio"] = chain._tensor_cpu_clone(
                source_tensors["delivered_audio"])
        latent_layout = "omitted"
        if save_latent:
            latent_tensors, latent_layout = _latent_checkpoint_tensors(
                upscaled_latent)
            tensors.update(latent_tensors)

        paths = _profile_paths(state["run_name"], state["profile"], index)
        for key in ("segment", "checkpoint", "metadata", "prompt", "audio"):
            os.makedirs(os.path.dirname(paths[key]), exist_ok=True)
        transaction = uuid.uuid4().hex
        segment_path = chain._versioned_path(paths["segment"], transaction)
        checkpoint_path = chain._versioned_path(paths["checkpoint"], transaction)
        metadata_path = chain._versioned_path(paths["metadata"], transaction)
        prompt_path = chain._versioned_path(paths["prompt"], transaction)
        audio_path = (chain._versioned_path(paths["audio"], transaction)
                      if "delivered_audio" in tensors else None)
        checkpoint_tmp = "%s.%s.tmp" % (checkpoint_path, uuid.uuid4().hex)
        committed = False
        try:
            chain._write_segment_video(
                delivered_images, segment_path, chain.FPS,
                int(state["profile_config"]["segment_crf"]), metadata={
                    "title": "H3 upscale scene %d - %s" %
                             (index, source.get("id", "scene")),
                    "comment": str(source.get("prompt") or ""),
                    "h3_upscale_profile": state["profile"],
                    "h3_upscale_backend": state["profile_config"]["backend"],
                    "h3_source_revision": str(source.get("revision") or ""),
                })
            chain._atomic_text(prompt_path, str(source.get("prompt") or ""))
            if audio_path is not None:
                chain._atomic_wav({
                    "waveform": tensors["delivered_audio"],
                    "sample_rate": sample_rate,
                }, audio_path)
            chain._st_save(tensors, checkpoint_tmp, metadata={
                "format": "h3_chain_upscale_checkpoint_v1",
                "index": str(index),
                "profile": state["profile"],
                "backend": state["profile_config"]["backend"],
                "source_revision": str(source.get("revision") or ""),
                "source_checkpoint_sha256": str(
                    source.get("checkpoint_sha256") or ""),
                "latent_layout": latent_layout,
                "latent_saved": "true" if save_latent else "false",
                "sample_rate": str(sample_rate),
            })
            os.replace(checkpoint_tmp, checkpoint_path)

            segment = {
                "index": index,
                "id": str(source.get("id") or "clip_%04d" % index),
                "revision": transaction,
                "created_at": datetime.now(timezone.utc).isoformat(
                    timespec="seconds").replace("+00:00", "Z"),
                "segment": chain._relative_output_path(segment_path),
                "checkpoint": chain._relative_output_path(checkpoint_path),
                "metadata": chain._relative_output_path(paths["metadata"]),
                "revision_metadata": chain._relative_output_path(metadata_path),
                "prompt_file": chain._relative_output_path(prompt_path),
                "raw_frames": raw,
                "delivered_frames": delivered,
                "trim_frames": trim,
                "width": width,
                "height": height,
                "sample_rate": sample_rate,
                "latent_saved": save_latent,
                "latent_layout": latent_layout,
                "source_revision": str(source.get("revision") or ""),
                "source_checkpoint": str(source.get("checkpoint") or ""),
                "source_checkpoint_sha256": str(
                    source.get("checkpoint_sha256") or ""),
                "source_segment_sha256": str(source.get("segment_sha256") or ""),
                "prompt_prefix": str(source.get("prompt_prefix") or ""),
                "scene_prompt": str(source.get("scene_prompt") or ""),
                "prompt": str(source.get("prompt") or ""),
                "prompt_hash": str(source.get("prompt_hash") or ""),
                "seed": source.get("seed"),
                "steps": source.get("steps"),
                "segment_sha256": chain._file_sha256(segment_path),
                "checkpoint_sha256": chain._file_sha256(checkpoint_path),
                "prompt_file_sha256": chain._file_sha256(prompt_path),
            }
            if audio_path is not None:
                segment.update({
                    "generated_audio": chain._relative_output_path(audio_path),
                    "generated_audio_sha256": chain._file_sha256(audio_path),
                })
            previous = None
            if os.path.isfile(paths["metadata"]):
                try:
                    previous = chain._read_json(paths["metadata"])
                except (OSError, ValueError, json.JSONDecodeError):
                    previous = None
            old_segment = previous.get("segment") if isinstance(previous, dict) else None
            if isinstance(old_segment, dict):
                segment["supersedes"] = old_segment.get("revision_metadata")
            metadata = {
                "format": "h3_chain_upscale_segment_v1",
                "run_name": state["run_name"],
                "profile": state["profile"],
                "source_manifest_hash": state["source_manifest_hash"],
                "profile_config_hash": state["profile_config"]["config_hash"],
                "profile_config": state["profile_config"],
                "segment": segment,
            }
            with chain.checkpoint_run_lock(chain._output_root(), state["run_name"]):
                chain._atomic_json(metadata_path, metadata)
                chain._atomic_json(paths["metadata"], metadata)
            prefix = list(state.get("segments", [])) + [segment]
            complete = (index == len(state["source_manifest"]["segments"]))
            partial = _upscale_manifest(state, prefix, complete=complete)
            chain._atomic_json(
                paths["manifest"] if complete else paths["partial"], partial)
            committed = True
        finally:
            chain._safe_unlink(checkpoint_tmp)
            if not committed:
                for value in (segment_path, checkpoint_path, metadata_path,
                              prompt_path, audio_path):
                    if value:
                        chain._safe_unlink(value)

        status = ("saved HQ scene %d/%d at %dx%d; latent %s -> %s" %
                  (index, len(state["source_manifest"]["segments"]), width,
                   height, "saved" if save_latent else "omitted", segment_path))
        return {
            "ui": {"text": [status],
                   "images": [chain._video_output_item(segment_path)],
                   "animated": (True,)},
            "result": (segment, status),
        }


class MiniMaxH3ChainUpscaleLoopEnd:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "flow": (UPSCALE_FLOW_TYPE, {
                    "rawLink": True,
                    "tooltip": "Connect directly from Upscale Adapter; this raw "
                               "link defines the recursive child-loop body."}),
                "state": (UPSCALE_STATE_TYPE, {
                    "tooltip": "Current child-run state from Upscale Current Scene."}),
                "images": ("IMAGE", {
                    "tooltip": "Same RAW HQ frames sent to Upscale Segment Save."}),
                "segment": (UPSCALE_SEGMENT_TYPE, {
                    "tooltip": "Persisted HQ scene record from Upscale Segment Save."}),
            },
            "optional": {
                "upscaled_latent": ("LATENT", {
                    "tooltip": "Optional transient HQ carry for the next scene. "
                               "It is independent of save_latent."}),
            },
            "hidden": {"dynprompt": "DYNPROMPT", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (UPSCALE_MANIFEST_TYPE, "STRING", "IMAGE", "LATENT")
    RETURN_NAMES = ("manifest", "manifest_json", "last_context_frames",
                    "last_context_latent")
    OUTPUT_TOOLTIPS = (
        "Complete verified child manifest for Upscale Merger, or a partial manifest.",
        "Readable JSON form of the emitted child manifest.",
        "Delivered HQ tail retained from the last processed scene.",
        "Transient HQ latent retained from the last processed scene, if connected.",
    )
    FUNCTION = "end"
    CATEGORY = "conditioning/minimax/contex_loop/upscale"
    DESCRIPTION = ("Advance the child upscale graph scene by scene and emit a "
                   "mergeable manifest after the selected range completes.")

    def _explore_dependencies(self, node_id, dynprompt, upstream, parent_ids):
        node_info = dynprompt.get_node(node_id)
        for value in node_info.get("inputs", {}).values():
            if not chain.is_link(value):
                continue
            parent_id = value[0]
            display_id = dynprompt.get_display_node_id(parent_id)
            display_node = dynprompt.get_node(display_id)
            if display_node["class_type"] != "MiniMaxH3ChainUpscaleLoopEnd":
                parent_ids.append(display_id)
            if parent_id not in upstream:
                upstream[parent_id] = []
                self._explore_dependencies(parent_id, dynprompt, upstream, parent_ids)
            upstream[parent_id].append(node_id)

    def _explore_output_nodes(self, dynprompt, upstream, parent_ids):
        try:
            import nodes as comfy_nodes
            mappings = comfy_nodes.NODE_CLASS_MAPPINGS
        except Exception:
            return
        output_nodes = {}
        for node_id, node in dynprompt.get_original_prompt().items():
            class_def = mappings.get(node.get("class_type"))
            if not class_def or not getattr(class_def, "OUTPUT_NODE", False):
                continue
            for value in node.get("inputs", {}).values():
                if chain.is_link(value):
                    output_nodes[node_id] = value
        for parent_id in list(upstream):
            display_id = dynprompt.get_display_node_id(parent_id)
            for output_id, link in output_nodes.items():
                linked_id = link[0]
                if (linked_id in parent_ids and display_id == linked_id and
                        output_id not in upstream[parent_id]):
                    if "." in parent_id:
                        parts = parent_id.split(".")
                        parts[-1] = output_id
                        upstream[parent_id].append(".".join(parts))
                    else:
                        upstream[parent_id].append(output_id)

    def _collect_contained(self, node_id, upstream, contained):
        for child_id in upstream.get(node_id, []):
            if child_id in contained:
                continue
            contained[child_id] = True
            self._collect_contained(child_id, upstream, contained)

    def _recurse(self, flow, next_state, dynprompt, unique_id):
        if chain.GraphBuilder is None:
            raise RuntimeError("H3 Upscale Loop requires ComfyUI GraphBuilder.")
        unique_id = str(unique_id)
        upstream, parent_ids = {}, []
        self._explore_dependencies(unique_id, dynprompt, upstream, parent_ids)
        parent_ids = list(set(parent_ids))
        self._explore_output_nodes(dynprompt, upstream, parent_ids)
        open_node = str(flow[0])
        start_info = dynprompt.get_node(open_node)
        if start_info["class_type"] != "MiniMaxH3ChainUpscaleAdapter":
            raise ValueError("Upscale Loop End flow must connect directly to Upscale Adapter.")
        contained = {unique_id: True, open_node: True}
        self._collect_contained(open_node, upstream, contained)
        graph = chain.GraphBuilder()
        for node_id in contained:
            original = dynprompt.get_node(node_id)
            clone_id = "Recurse" if node_id == unique_id else node_id
            node = graph.node(original["class_type"], clone_id)
            node.set_override_display_id(node_id)
        for node_id in contained:
            original = dynprompt.get_node(node_id)
            clone_id = "Recurse" if node_id == unique_id else node_id
            node = graph.lookup_node(clone_id)
            for key, value in original.get("inputs", {}).items():
                if chain.is_link(value) and value[0] in contained:
                    parent = graph.lookup_node(value[0])
                    node.set_input(key, parent.out(value[1]))
                else:
                    node.set_input(key, value)
        graph.lookup_node(open_node).set_input("initial_state", next_state)
        recurse = graph.lookup_node("Recurse")
        return {"result": tuple(recurse.out(index)
                                for index in range(len(self.RETURN_TYPES))),
                "expand": graph.finalize()}

    def end(self, flow, state, images, segment, upscaled_latent=None,
            dynprompt=None, unique_id=None):
        index = int(state["index"])
        if int(segment.get("index", -1)) != index:
            raise ValueError("Upscale Loop End received the wrong scene segment.")
        source = _source_segment(state)
        raw = int(source["raw_frames"])
        delivered = int(source["delivered_frames"])
        trim = raw - delivered
        if int(images.shape[0]) != raw:
            raise ValueError("Upscale Loop End expected %d RAW frames." % raw)
        delivered_images = images[trim:trim + delivered]
        context_length = min(
            int(state["source_manifest"].get("compatibility", {}).get(
                "context_length", 0)), delivered)
        next_state = dict(state)
        next_state.update({
            "index": index + 1,
            "segments": list(state.get("segments", [])) +
                        [_public_upscale_segment(segment)],
            "previous_frames": chain._tensor_cpu_clone(
                delivered_images[-context_length:]) if context_length else
                chain._tensor_cpu_clone(delivered_images[:0]),
            "previous_latent": _cpu_latent(upscaled_latent),
        })
        if index < int(state["end_clip"]):
            return self._recurse(flow, next_state, dynprompt, unique_id)
        complete = index == len(state["source_manifest"]["segments"])
        manifest = _upscale_manifest(state, next_state["segments"], complete)
        paths = _profile_paths(state["run_name"], state["profile"], index)
        chain._atomic_json(paths["manifest"] if complete else paths["partial"],
                           manifest)
        manifest_json = json.dumps(manifest, ensure_ascii=False, indent=2,
                                   sort_keys=True)
        return (manifest, manifest_json, next_state["previous_frames"],
                next_state["previous_latent"])


def _validate_upscale_manifest(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    if manifest.get("format") != "h3_chain_upscale_manifest_v1":
        raise ValueError("Upscale Merger requires a complete upscale manifest.")
    segments = manifest.get("segments") or []
    count = int(manifest.get("clip_count", 0))
    if count < 1 or len(segments) != count:
        raise ValueError("Upscale manifest contains %d/%d scenes." %
                         (len(segments), count))
    total = 0
    for index, segment in enumerate(segments, start=1):
        _verify_upscale_segment(segment, index)
        total += int(segment.get("delivered_frames", 0))
    if total != int(manifest.get("total_delivered_frames", -1)):
        raise ValueError("Upscale manifest delivered-frame total is inconsistent.")
    return segments


def _assembly_manifest(manifest: dict[str, Any],
                       segments: list[dict[str, Any]]) -> dict[str, Any]:
    source = manifest.get("source_manifest")
    if not isinstance(source, dict):
        raise ValueError("Upscale manifest has no embedded source manifest.")
    compatibility = dict(source.get("compatibility") or {})
    compatibility["video_blend_frames"] = 0
    compatibility["segment_crf"] = int(
        manifest["profile_config"].get("segment_crf", 18))
    assembled = []
    for item in segments:
        assembled.append({
            **item,
            "blend_frames": 0,
        })
    return {
        "format": "h3_chain_manifest_v3",
        "run_name": manifest["run_name"],
        "plan_hash": source.get("plan_hash"),
        "prompt_prefix": source.get("prompt_prefix", ""),
        "compatibility": compatibility,
        "clip_count": len(assembled),
        "total_delivered_frames": int(manifest["total_delivered_frames"]),
        "duration_seconds": float(manifest["duration_seconds"]),
        "segments": assembled,
        "archives": source.get("archives", {}),
        "upscale": {
            "profile": manifest["profile"],
            "source_manifest_hash": manifest["source_manifest_hash"],
            "profile_config": manifest["profile_config"],
        },
    }


class MiniMaxH3ChainUpscaleMerge:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "manifest": (UPSCALE_MANIFEST_TYPE, {
                    "tooltip": "Complete manifest emitted after the child loop "
                               "reaches the final source scene."}),
                "audio_source": (["plan", "source", "generated", "none"],
                                 {"default": "plan",
                                  "tooltip": "Final audio policy. plan follows the "
                                             "parent chain's configured mode."}),
                "filename": ("STRING", {
                    "default": "final",
                    "tooltip": "Final MP4 basename; collisions are versioned."}),
                "audio_bitrate": ("INT", {
                    "default": 256, "min": 64, "max": 512,
                    "tooltip": "AAC bitrate in kbps when audio is muxed."}),
            },
            "optional": {
                "source_audio": ("AUDIO", {
                    "tooltip": "Original full source track when audio_source "
                               "resolves to source."}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("video_path",)
    OUTPUT_TOOLTIPS = (
        "Absolute path of the verified merged HQ MP4 under the child profile.",
    )
    FUNCTION = "merge"
    OUTPUT_NODE = True
    CATEGORY = "conditioning/minimax/contex_loop/upscale"
    DESCRIPTION = ("Verify HQ child segments, reuse the source audio contract, "
                   "and publish under upscaled/<profile>/final.")

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return float("NaN")

    def merge(self, manifest, audio_source, filename, audio_bitrate,
              source_audio=None):
        segments = _validate_upscale_manifest(manifest)
        assembly = _assembly_manifest(manifest, segments)
        temporary_name = "upscale_merge_%s" % uuid.uuid4().hex
        result = chain.MiniMaxH3ChainAssemble().assemble(
            assembly, audio_source, temporary_name, audio_bitrate,
            source_audio=source_audio)
        temporary = result["result"][0]
        paths = _profile_paths(manifest["run_name"], manifest["profile"], 1)
        os.makedirs(paths["final"], exist_ok=True)
        final_name = chain._safe_name(
            chain._expand_filename_date(filename), "final") + ".mp4"
        final_path = chain._available_versioned_path(
            os.path.join(paths["final"], final_name))
        temporary_sidecar = os.path.splitext(temporary)[0] + ".generated.wav"
        final_sidecar = os.path.splitext(final_path)[0] + ".generated.wav"
        try:
            os.replace(temporary, final_path)
            if os.path.isfile(temporary_sidecar):
                os.replace(temporary_sidecar, final_sidecar)
        except Exception:
            if os.path.isfile(final_path) and not os.path.isfile(temporary):
                os.replace(final_path, temporary)
            raise
        record = {
            "format": "h3_chain_upscale_final_v1",
            "run_name": manifest["run_name"],
            "profile": manifest["profile"],
            "profile_config": manifest["profile_config"],
            "source_manifest_hash": manifest["source_manifest_hash"],
            "video": chain._relative_output_path(final_path),
            "video_sha256": chain._file_sha256(final_path),
            "frame_count": int(manifest["total_delivered_frames"]),
            "created_at": datetime.now(timezone.utc).isoformat(
                timespec="seconds").replace("+00:00", "Z"),
        }
        if os.path.isfile(final_sidecar):
            record.update({
                "generated_audio": chain._relative_output_path(final_sidecar),
                "generated_audio_sha256": chain._file_sha256(final_sidecar),
            })
        chain._atomic_json(os.path.splitext(final_path)[0] + ".json", record)
        status = "merged %d HQ scenes -> %s" % (len(segments), final_path)
        return {
            "ui": {"text": [status],
                   "images": [chain._video_output_item(final_path)],
                   "animated": (True,)},
            "result": (final_path,),
        }


UPSCALE_NODE_CLASS_MAPPINGS = {
    "MiniMaxH3ChainUpscaleAdapter": MiniMaxH3ChainUpscaleAdapter,
    "MiniMaxH3ChainUpscaleCurrent": MiniMaxH3ChainUpscaleCurrent,
    "MiniMaxH3ChainUpscaleSegmentSave": MiniMaxH3ChainUpscaleSegmentSave,
    "MiniMaxH3ChainUpscaleLoopEnd": MiniMaxH3ChainUpscaleLoopEnd,
    "MiniMaxH3ChainUpscaleMerge": MiniMaxH3ChainUpscaleMerge,
}

UPSCALE_NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3ChainUpscaleAdapter": "MiniMax H3 Checkpoint Upscale Adapter",
    "MiniMaxH3ChainUpscaleCurrent": "MiniMax H3 Upscale Current Scene",
    "MiniMaxH3ChainUpscaleSegmentSave": "MiniMax H3 Upscale Segment Save",
    "MiniMaxH3ChainUpscaleLoopEnd": "MiniMax H3 Upscale Loop End",
    "MiniMaxH3ChainUpscaleMerge": "MiniMax H3 Upscale Merger",
}
