export function formatCheckpointBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function checkpointRevisionKey(scene, revision) {
    return `${Number(scene)}:${String(revision ?? "").toLowerCase()}`;
}

export function checkpointRevisionMap(payload) {
    return new Map((payload?.revisions ?? []).map((item) => [
        checkpointRevisionKey(item.scene, item.revision), item,
    ]));
}

export function selectedCheckpointRevision(payload, scene = null, revision = "") {
    const revisions = Array.isArray(payload?.revisions) ? payload.revisions : [];
    const wantedScene = Number(scene);
    const wantedRevision = String(revision ?? "").toLowerCase();
    if (Number.isInteger(wantedScene) && wantedRevision) {
        const exact = revisions.find((item) =>
            Number(item.scene) === wantedScene &&
            String(item.revision).toLowerCase() === wantedRevision);
        if (exact) return exact;
    }
    const sceneRevisions = Number.isInteger(wantedScene)
        ? revisions.filter((item) => Number(item.scene) === wantedScene) : [];
    return sceneRevisions.find((item) => item.active)
        ?? sceneRevisions.sort((left, right) =>
            String(right.created_at).localeCompare(String(left.created_at)))[0]
        ?? revisions.find((item) => item.active)
        ?? revisions[0]
        ?? null;
}

export function checkpointBranchRows(payload) {
    const revisions = checkpointRevisionMap(payload);
    return (payload?.branches ?? []).map((branch) => ({
        ...branch,
        revisions: (branch.path ?? []).map((item) =>
            revisions.get(checkpointRevisionKey(item.scene, item.revision)))
            .filter(Boolean),
    }));
}

export function checkpointDependencyText(item) {
    const scene = Number(item?.scene) || 0;
    const id = String(item?.scene_id ?? `clip_${String(scene).padStart(4, "0")}`);
    const video = Math.max(0, Number(item?.context_length) || 0);
    const audio = Math.max(0, Number(item?.audio_context_length) || 0);
    const mode = String(item?.continuation_mode ?? "guide");
    const relationship = video || audio
        ? `uses Video ${video}f / Audio ${audio}f via ${mode}`
        : `has a structural continuation edge (Video 0f / Audio 0f)`;
    return `Scene ${scene} · ${id} ${relationship}`;
}

export function checkpointDeletionTitle(preview) {
    if (!preview) return "Select a checkpoint revision to inspect deletion safety.";
    if (preview.allowed) {
        return `Safe leaf deletion · ${preview.owned_file_count} files · ${formatCheckpointBytes(preview.reclaimed_bytes)}`;
    }
    return (preview.blockers ?? []).join(" ") || "Deletion is blocked.";
}
