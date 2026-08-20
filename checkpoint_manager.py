"""Dependency-aware discovery and deletion for H3 scene checkpoints."""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import uuid
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any


_REVISION = re.compile(r"clip_(\d{4})\.([0-9a-f]{32})\.json")
_ACTIVE = re.compile(r"clip_(\d{4})\.json")
_ARTIFACT_KEYS = (
    "segment", "checkpoint", "prompt_file", "generated_audio",
    "blend_segment", "revision_metadata",
)
_ARTIFACT_KINDS = {
    "segment": "Segment video",
    "checkpoint": "Continuation checkpoint",
    "prompt_file": "Prompt snapshot",
    "generated_audio": "Generated audio",
    "blend_segment": "Blend-ready video",
    "revision_metadata": "Revision metadata",
    "review_preview": "Review preview",
}
_RUN_LOCKS: dict[tuple[str, str], threading.RLock] = {}
_RUN_LOCKS_GUARD = threading.Lock()


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


def _fingerprint(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _safe_name(value: Any) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip())
    return text.strip("._-")[:96]


def checkpoint_run_lock(output_root: str, run_name: Any) -> threading.RLock:
    """Return the process-local mutation lock shared by save and delete."""
    root = os.path.realpath(os.path.abspath(output_root))
    run = _safe_name(run_name)
    key = (root, run)
    with _RUN_LOCKS_GUARD:
        return _RUN_LOCKS.setdefault(key, threading.RLock())


class CheckpointDeleteBlocked(ValueError):
    """Deletion was safe to inspect but is blocked by checkpoint state."""

    def __init__(self, message: str, preview: dict[str, Any]):
        super().__init__(message)
        self.preview = preview


class CheckpointGraphManager:
    """Build lineage graphs and remove only dependency-free revisions."""

    def __init__(self, output_root: str):
        self.output_root = os.path.realpath(os.path.abspath(output_root))
        self.chains_root = os.path.realpath(os.path.join(
            self.output_root, "h3_chains"))

    @staticmethod
    def _inside(root: str, path: str) -> bool:
        try:
            return os.path.commonpath([root, path]) == root
        except ValueError:
            return False

    def _run_dir(self, run_name: Any) -> tuple[str, str]:
        run = _safe_name(run_name)
        if not run:
            raise ValueError("A non-empty H3 chain run_name is required.")
        path = os.path.realpath(os.path.join(self.chains_root, run))
        if not self._inside(self.output_root, path):
            raise ValueError("H3 checkpoint run path escapes the output directory.")
        return path, run

    def _artifact_path(self, value: Any) -> str:
        text = str(value or "").strip()
        if not text:
            raise ValueError("Checkpoint artifact path is empty.")
        path = os.path.realpath(
            text if os.path.isabs(text) else os.path.join(self.output_root, text))
        if not self._inside(self.output_root, path):
            raise ValueError("Checkpoint artifact path escapes the output directory.")
        return path

    def _output_item(self, path: str) -> dict[str, str]:
        relative = os.path.relpath(path, self.output_root)
        return {
            "filename": os.path.basename(relative),
            "subfolder": os.path.dirname(relative),
            "type": "output",
        }

    @staticmethod
    def _read_json(path: str) -> Any:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    @staticmethod
    def _integer(value: Any, fallback: int = 0) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return int(fallback)

    @staticmethod
    def _created_at(metadata: dict[str, Any], path: str) -> str:
        stored = str(metadata.get("created_at") or
                     metadata.get("segment", {}).get("created_at") or "")
        if stored:
            return stored
        return datetime.fromtimestamp(
            os.path.getmtime(path), timezone.utc).isoformat(
                timespec="seconds").replace("+00:00", "Z")

    def _effective_context(
            self, scene: int, segment: dict[str, Any],
            compatibility: dict[str, Any]) -> tuple[str, int, int]:
        """Return context that actually depended on the preceding checkpoint."""
        continuation = str(
            segment.get("continuation_mode") or
            compatibility.get("continuation_mode") or "guide")
        context = self._integer(
            segment.get("resolved_context_length",
                        segment.get("context_length",
                                    compatibility.get("context_length", 0))))
        has_resolved_audio = "resolved_audio_context_length" in segment
        if has_resolved_audio:
            audio_context = self._integer(
                segment.get("resolved_audio_context_length"))
        elif "audio_context_length" in segment:
            audio_context = self._integer(segment.get("audio_context_length"))
        elif "audio_context_length" in compatibility:
            audio_context = self._integer(
                compatibility.get("audio_context_length"))
        else:
            audio_context = context
        if scene <= 1:
            return continuation, 0, 0
        audio_mode = str(compatibility.get("audio_mode") or "source_track")
        if (not has_resolved_audio and continuation != "masked_av" and
                audio_mode not in (
                    "generated_audio", "source_plus_timeline")):
            audio_context = 0
        return continuation, max(0, context), max(0, audio_context)

    def _active_revisions(self, checkpoint_dir: str) -> dict[int, str]:
        active: dict[int, str] = {}
        if not os.path.isdir(checkpoint_dir):
            return active
        for filename in os.listdir(checkpoint_dir):
            match = _ACTIVE.fullmatch(filename)
            if match is None:
                continue
            try:
                metadata = self._read_json(os.path.join(checkpoint_dir, filename))
                segment = metadata.get("segment")
                if not isinstance(segment, dict):
                    continue
                scene = int(match.group(1))
                if int(segment.get("index", -1)) != scene:
                    continue
                revision = str(segment.get("revision") or "").lower()
                if re.fullmatch(r"[0-9a-f]{32}", revision):
                    active[scene] = revision
            except (OSError, TypeError, ValueError, json.JSONDecodeError,
                    AttributeError):
                continue
        return active

    def _scan(self, run_name: Any) -> dict[str, Any]:
        run_dir, run = self._run_dir(run_name)
        checkpoint_dir = os.path.join(run_dir, "checkpoints")
        review_dir = os.path.join(run_dir, "reviews")
        active = self._active_revisions(checkpoint_dir)
        records: dict[tuple[int, str], dict[str, Any]] = {}
        if os.path.isdir(checkpoint_dir):
            for filename in sorted(os.listdir(checkpoint_dir)):
                match = _REVISION.fullmatch(filename)
                if match is None:
                    continue
                metadata_path = os.path.realpath(os.path.join(
                    checkpoint_dir, filename))
                try:
                    metadata = self._read_json(metadata_path)
                    segment = metadata.get("segment")
                    if not isinstance(segment, dict):
                        continue
                    scene = int(segment.get("index", int(match.group(1))))
                    revision = str(
                        segment.get("revision") or match.group(2)).lower()
                    stored_run = _safe_name(metadata.get("run_name") or run)
                    if (scene != int(match.group(1)) or
                            revision != match.group(2) or stored_run != run):
                        continue
                    compatibility = metadata.get("compatibility")
                    if not isinstance(compatibility, dict):
                        compatibility = {}
                    continuation, context, audio_context = (
                        self._effective_context(scene, segment, compatibility))
                    segment_path = self._artifact_path(segment.get("segment"))
                    checkpoint_path = self._artifact_path(
                        segment.get("checkpoint"))
                    record = {
                        "scene": scene,
                        "scene_id": str(
                            segment.get("id") or "clip_%04d" % scene),
                        "revision": revision,
                        "active": active.get(scene) == revision,
                        "ready": (os.path.isfile(segment_path) and
                                  os.path.isfile(checkpoint_path)),
                        "raw_frames": self._integer(
                            segment.get("raw_frames")),
                        "delivered_frames": self._integer(
                            segment.get("delivered_frames")),
                        "seed": str(segment.get("seed") or ""),
                        "steps": self._integer(segment.get("steps")),
                        "created_at": self._created_at(metadata, metadata_path),
                        "branch_id": str(segment.get("branch_id") or ""),
                        "forked_from_branch_id": str(
                            segment.get("forked_from_branch_id") or ""),
                        "predecessor_revision": str(
                            segment.get("predecessor_revision") or "").lower(),
                        "predecessor_checkpoint_sha256": str(
                            segment.get("predecessor_checkpoint_sha256") or ""),
                        "checkpoint_sha256": str(
                            segment.get("checkpoint_sha256") or ""),
                        "segment_sha256": str(
                            segment.get("segment_sha256") or ""),
                        "continuation_mode": continuation,
                        "context_length": context,
                        "audio_context_length": audio_context,
                        "compatibility": {
                            key: compatibility[key] for key in (
                                "width", "height", "fps", "audio_mode",
                                "generation_fingerprint", "encode_mode",
                                "anchor_mode", "crop")
                            if key in compatibility
                        },
                        "prompt_preview": re.sub(
                            r"\s+", " ", str(
                                segment.get("scene_prompt") or
                                segment.get("prompt") or "").strip())[:240],
                        "prompt": str(segment.get("prompt") or
                                      segment.get("scene_prompt") or ""),
                        "_metadata": metadata,
                        "_metadata_path": metadata_path,
                        "_segment": segment,
                        "_segment_path": segment_path,
                        "_checkpoint_path": checkpoint_path,
                        "_parent": None,
                        "_children": [],
                        "_lineage_issue": "",
                    }
                    records[(scene, revision)] = record
                except (OSError, TypeError, ValueError, json.JSONDecodeError,
                        AttributeError):
                    continue

        by_hash: dict[tuple[int, str], list[tuple[int, str]]] = defaultdict(list)
        for key, record in records.items():
            digest = record["checkpoint_sha256"]
            if digest:
                by_hash[(record["scene"], digest)].append(key)
        for key, record in records.items():
            scene = record["scene"]
            if scene <= 1:
                continue
            revision = record["predecessor_revision"]
            digest = record["predecessor_checkpoint_sha256"]
            parent_key = (scene - 1, revision) if revision else None
            parent = records.get(parent_key) if parent_key else None
            if parent is None and digest:
                candidates = by_hash.get((scene - 1, digest), [])
                if len(candidates) == 1:
                    parent_key = candidates[0]
                    parent = records[parent_key]
            if parent is None:
                record["_lineage_issue"] = "missing predecessor"
                continue
            if digest and parent["checkpoint_sha256"] != digest:
                record["_lineage_issue"] = "predecessor hash mismatch"
                # Keep the declared revision edge for conservative cleanup:
                # corrupted lineage must never make its parent look deletable.
            record["_parent"] = parent_key
            parent["_children"].append(key)

        try:
            review_names = os.listdir(review_dir) if os.path.isdir(
                review_dir) else []
        except OSError:
            review_names = []
        segment_hash_counts: dict[str, int] = defaultdict(int)
        for record in records.values():
            if record["segment_sha256"]:
                segment_hash_counts[record["segment_sha256"]] += 1
        return {
            "run_dir": run_dir,
            "run_name": run,
            "checkpoint_dir": checkpoint_dir,
            "review_dir": review_dir,
            "review_names": review_names,
            "records": records,
            "segment_hash_counts": segment_hash_counts,
        }

    def _artifacts(self, scan: dict[str, Any], record: dict[str, Any]
                   ) -> list[dict[str, Any]]:
        run_dir = scan["run_dir"]
        allowed_roots = [os.path.realpath(os.path.join(run_dir, name)) for name in (
            "segments", "checkpoints", "generated_audio", "blend_segments",
            "reviews")]
        paths: dict[str, tuple[str, bool]] = {
            record["_metadata_path"]: ("revision_metadata", False),
        }
        for key in _ARTIFACT_KEYS:
            value = record["_segment"].get(key)
            if not isinstance(value, str) or not value:
                continue
            path = self._artifact_path(value)
            paths.setdefault(path, (key, False))
        video_hash = record["segment_sha256"][:12]
        if video_hash and os.path.isdir(scan["review_dir"]):
            prefix = "clip_%04d.%s." % (record["scene"], video_hash)
            shared = scan["segment_hash_counts"].get(
                record["segment_sha256"], 0) > 1
            for candidate in scan["review_names"]:
                if candidate.startswith(prefix) and candidate.endswith(
                        ".review.mp4"):
                    path = os.path.realpath(os.path.join(
                        scan["review_dir"], candidate))
                    paths[path] = ("review_preview", shared)

        expected_prefix = "clip_%04d.%s" % (
            record["scene"], record["revision"])
        canonical = os.path.realpath(os.path.join(
            scan["checkpoint_dir"], "clip_%04d.json" % record["scene"]))
        artifacts = []
        for path, (kind, shared) in sorted(paths.items()):
            if path == canonical:
                raise ValueError("Refusing to manage an active checkpoint pointer.")
            if not any(self._inside(root, path) for root in allowed_roots):
                raise ValueError("Checkpoint revision owns an unexpected path.")
            if (not self._inside(scan["review_dir"], path) and
                    not os.path.basename(path).startswith(expected_prefix)):
                raise ValueError(
                    "Checkpoint revision references a file owned by another revision.")
            try:
                exists = os.path.isfile(path)
                stat_result = os.stat(path) if exists else None
            except OSError:
                exists = False
                stat_result = None
            size = int(stat_result.st_size) if stat_result is not None else 0
            mtime_ns = (int(stat_result.st_mtime_ns)
                        if stat_result is not None else 0)
            artifacts.append({
                "kind": kind,
                "label": _ARTIFACT_KINDS.get(kind, kind.replace("_", " ").title()),
                "path": os.path.relpath(path, self.output_root),
                "exists": exists,
                "size_bytes": size,
                "shared": bool(shared),
                "owned": not shared,
                "_path": path,
                "_mtime_ns": mtime_ns,
            })
        return artifacts

    @staticmethod
    def _descendant_keys(records: dict[tuple[int, str], dict[str, Any]],
                         start: tuple[int, str]) -> list[tuple[int, str]]:
        found = []
        queue = deque(records[start]["_children"])
        seen = set()
        while queue:
            key = queue.popleft()
            if key in seen or key not in records:
                continue
            seen.add(key)
            found.append(key)
            queue.extend(records[key]["_children"])
        return sorted(found, key=lambda item: (item[0], item[1]))

    def _public_graph(self, scan: dict[str, Any]) -> dict[str, Any]:
        records = scan["records"]
        leaves = [key for key, record in records.items()
                  if not record["_children"]]
        branch_paths = []
        memberships: dict[tuple[int, str], list[dict[str, Any]]] = defaultdict(list)
        for leaf_key in leaves:
            path = []
            cursor = leaf_key
            seen = set()
            while cursor in records and cursor not in seen:
                seen.add(cursor)
                path.append(cursor)
                cursor = records[cursor]["_parent"]
            path.reverse()
            leaf = records[leaf_key]
            active = bool(path) and all(records[key]["active"] for key in path)
            branch_id = leaf["branch_id"] or leaf["revision"]
            branch = {
                "id": branch_id,
                "label": "Active branch" if active else "Branch %s" % branch_id[:8],
                "active": active,
                "leaf_scene": leaf["scene"],
                "leaf_revision": leaf["revision"],
                "path": [{"scene": key[0], "revision": key[1]} for key in path],
            }
            branch_paths.append(branch)
            membership = {"id": branch["id"], "label": branch["label"],
                          "active": active}
            for key in path:
                memberships[key].append(membership)
        branch_paths.sort(key=lambda item: (
            not item["active"], -int(item["leaf_scene"]), item["id"]))

        public_records = []
        for key in sorted(records):
            record = records[key]
            artifacts = self._artifacts(scan, record)
            reviews = [item for item in artifacts
                       if item["kind"] == "review_preview" and item["exists"]]
            video = (self._output_item(record["_segment_path"])
                     if os.path.isfile(record["_segment_path"]) else None)
            audio = None
            audio_value = record["_segment"].get("generated_audio")
            if isinstance(audio_value, str) and audio_value:
                audio_path = self._artifact_path(audio_value)
                if os.path.isfile(audio_path):
                    audio = self._output_item(audio_path)
            parent = record["_parent"]
            children = []
            for child_key in sorted(record["_children"]):
                child = records[child_key]
                children.append({
                    "scene": child["scene"],
                    "scene_id": child["scene_id"],
                    "revision": child["revision"],
                    "continuation_mode": child["continuation_mode"],
                    "context_length": child["context_length"],
                    "audio_context_length": child["audio_context_length"],
                })
            item = {name: record[name] for name in (
                "scene", "scene_id", "revision", "active", "ready",
                "raw_frames", "delivered_frames", "seed", "steps",
                "created_at", "branch_id", "forked_from_branch_id",
                "predecessor_revision",
                "predecessor_checkpoint_sha256", "checkpoint_sha256",
                "continuation_mode", "context_length", "audio_context_length",
                "compatibility", "prompt_preview", "prompt")}
            item.update({
                "size_bytes": sum(part["size_bytes"] for part in artifacts
                                  if part["owned"]),
                "missing_files": [part["label"] for part in artifacts
                                  if part["owned"] and not part["exists"]],
                "video": video,
                "audio": audio,
                "preview_video": (
                    self._output_item(reviews[-1]["_path"]) if reviews else None),
                "parent": ({"scene": parent[0], "revision": parent[1]}
                           if parent else None),
                "children": children,
                "descendant_count": len(self._descendant_keys(records, key)),
                "branches": memberships.get(key, []),
                "lineage_status": record["_lineage_issue"] or (
                    "root" if record["scene"] == 1 else "linked"),
                "metadata_path": os.path.relpath(
                    record["_metadata_path"], self.output_root),
            })
            public_records.append(item)
        scenes = []
        grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for item in public_records:
            grouped[item["scene"]].append(item)
        for scene in sorted(grouped):
            revisions = grouped[scene]
            scenes.append({
                "scene": scene,
                "scene_id": next((item["scene_id"] for item in revisions
                                  if item["active"]), revisions[0]["scene_id"]),
                "revision_count": len(revisions),
                "active_revision": next((item["revision"] for item in revisions
                                         if item["active"]), ""),
                "bytes": sum(item["size_bytes"] for item in revisions),
                "broken_count": sum(not item["ready"] for item in revisions),
            })
        graph_hash = _fingerprint([{
            "scene": item["scene"], "revision": item["revision"],
            "active": item["active"], "ready": item["ready"],
            "parent": item["parent"], "size_bytes": item["size_bytes"],
        } for item in public_records])
        return {
            "run_name": scan["run_name"],
            "graph_hash": graph_hash,
            "scenes": scenes,
            "branches": branch_paths,
            "revisions": public_records,
            "summary": {
                "scene_count": len(scenes),
                "revision_count": len(public_records),
                "branch_count": len(branch_paths),
                "bytes": sum(item["size_bytes"] for item in public_records),
                "broken_count": sum(not item["ready"] for item in public_records),
            },
        }

    def graph(self, run_name: Any) -> dict[str, Any]:
        run_dir, run = self._run_dir(run_name)
        if not os.path.isdir(run_dir):
            raise FileNotFoundError("H3 run %r does not exist." % run)
        return self._public_graph(self._scan(run))

    def deletion_preview(self, run_name: Any, scene: Any,
                         revision: Any) -> dict[str, Any]:
        run_dir, run = self._run_dir(run_name)
        scene_number = int(scene)
        token = str(revision or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{32}", token):
            raise ValueError("Checkpoint revision must be a 32-character revision id.")
        with checkpoint_run_lock(self.output_root, run):
            if not os.path.isdir(run_dir):
                raise FileNotFoundError("H3 run %r does not exist." % run)
            scan = self._scan(run)
            key = (scene_number, token)
            record = scan["records"].get(key)
            if record is None:
                raise FileNotFoundError(
                    "Scene %d revision %s is no longer available." %
                    (scene_number, token[:8]))
            artifacts = self._artifacts(scan, record)
            descendant_keys = self._descendant_keys(scan["records"], key)
            dependents = []
            for child_key in descendant_keys:
                child = scan["records"][child_key]
                dependents.append({
                    "scene": child["scene"],
                    "scene_id": child["scene_id"],
                    "revision": child["revision"],
                    "active": child["active"],
                    "direct": child["_parent"] == key,
                    "leaf": not child["_children"],
                    "continuation_mode": child["continuation_mode"],
                    "context_length": child["context_length"],
                    "audio_context_length": child["audio_context_length"],
                })
            dependents.sort(key=lambda item: (
                not item["leaf"], -int(item["scene"]), item["revision"]))
            blockers = []
            if record["active"]:
                blockers.append("This is the active revision for scene %d." % scene_number)
            if dependents:
                blockers.append(
                    "%d later checkpoint revision%s depend%s on it." %
                    (len(dependents), "" if len(dependents) == 1 else "s",
                     "s" if len(dependents) == 1 else ""))
            public_files = [{key: value for key, value in item.items()
                             if not key.startswith("_")} for item in artifacts]
            snapshot = _fingerprint({
                "run_name": run,
                "scene": scene_number,
                "revision": token,
                "active": record["active"],
                "dependents": [(item["scene"], item["revision"])
                               for item in dependents],
                "files": [(item["path"], item["exists"], item["size_bytes"],
                           item["shared"], artifact["_mtime_ns"])
                          for item, artifact in zip(public_files, artifacts)],
            })
            owned = [item for item in public_files if item["owned"]]
            return {
                "ok": True,
                "run_name": run,
                "scene": scene_number,
                "scene_id": record["scene_id"],
                "revision": token,
                "active": record["active"],
                "allowed": not blockers,
                "blockers": blockers,
                "dependents": dependents,
                "files": public_files,
                "owned_file_count": sum(item["exists"] for item in owned),
                "reclaimed_bytes": sum(item["size_bytes"] for item in owned),
                "snapshot": snapshot,
                "not_deleted": [
                    "Run Plan and workflow archives",
                    "Archived references and source media",
                    "Prompt revision history",
                    "Final and partial assembled exports",
                ],
            }

    def delete(self, run_name: Any, scene: Any, revision: Any,
               expected_snapshot: Any = "") -> dict[str, Any]:
        run_dir, run = self._run_dir(run_name)
        with checkpoint_run_lock(self.output_root, run):
            preview = self.deletion_preview(run, scene, revision)
            expected = str(expected_snapshot or "")
            if not preview["allowed"]:
                raise CheckpointDeleteBlocked(" ".join(preview["blockers"]), preview)
            if not expected:
                raise CheckpointDeleteBlocked(
                    "Preview this checkpoint deletion before confirming it.",
                    preview)
            if expected != preview["snapshot"]:
                raise CheckpointDeleteBlocked(
                    "Checkpoint files or dependencies changed; preview the deletion again.",
                    preview)
            scan = self._scan(run)
            key = (int(scene), str(revision).strip().lower())
            record = scan["records"][key]
            artifacts = [item for item in self._artifacts(scan, record)
                         if item["owned"] and item["exists"]]
            transaction = uuid.uuid4().hex
            staged = []
            try:
                for artifact in artifacts:
                    path = artifact["_path"]
                    temporary = "%s.delete.%s.tmp" % (path, transaction)
                    os.replace(path, temporary)
                    staged.append((path, temporary, artifact["size_bytes"]))
            except Exception:
                for original, temporary, _size in reversed(staged):
                    try:
                        os.replace(temporary, original)
                    except Exception:
                        pass
                raise
            failed = []
            for _original, temporary, _size in staged:
                try:
                    os.unlink(temporary)
                except OSError:
                    failed.append(temporary)
            reclaimed = sum(size for _original, temporary, size in staged
                            if temporary not in failed)
            return {
                "ok": True,
                "run_name": run,
                "scene": int(scene),
                "revision": str(revision).strip().lower(),
                "deleted_files": len(staged) - len(failed),
                "reclaimed_bytes": reclaimed,
                "message": "Deleted scene %d revision %s." %
                           (int(scene), str(revision)[:8]),
            }
