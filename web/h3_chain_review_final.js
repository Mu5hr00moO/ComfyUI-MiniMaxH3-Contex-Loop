import {app} from "/scripts/app.js";
import {api} from "/scripts/api.js";
import {
    parsePlanJson,
    planToJson,
    promptValueToText,
} from "./h3_chain_plan_core.mjs?v=0.4.20";
import * as promptCompanionSync from "./h3_prompt_companion_sync.mjs?v=0.4.20";
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
} from "./h3_chain_review_core.mjs?v=0.4.20";

const NODE_NAME = "MiniMaxH3ChainReview";
const PLAN_NAME = "MiniMaxH3ChainPlan";
const VIDEO_HEIGHT_PROPERTY = "h3_chain_review_video_height";
const PROMPT_HEIGHT_PROPERTY = "h3_chain_review_prompt_height";
const DEFAULT_VIDEO_HEIGHT = 300;
const MIN_VIDEO_HEIGHT = 140;
const MAX_VIDEO_HEIGHT = 1200;
const notifiedTokens = new Set();
const mountedReviewNodes = new Set();
let notificationAudioContext = null;
let pendingFetchPromise = null;
let pendingPollTimer = null;

// A browser can briefly retain the preceding companion module after updating
// a custom node. Namespace access keeps Review Gate mountable in that state;
// prompt synchronization becomes a no-op until the module cache refreshes.
function publishCompanionPrompt(...args) {
    return promptCompanionSync.publishCompanionPrompt?.(...args) ?? 0;
}

function publishPlanCompanionScene(...args) {
    return promptCompanionSync.publishPlanCompanionScene?.(...args) ?? 0;
}

function ensureNotificationAudioContext() {
    const AudioContext = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContext) return null;
    notificationAudioContext ??= new AudioContext();
    return notificationAudioContext;
}

function unlockNotificationAudio() {
    ensureNotificationAudioContext()?.resume?.().catch(() => {});
}

// Queueing a workflow is normally the needed user gesture. Prime WebAudio on
// the first interaction so a much later review notification is not rejected by
// browser autoplay policy.
window.addEventListener("pointerdown", unlockNotificationAudio, {once: true, capture: true});
window.addEventListener("keydown", unlockNotificationAudio, {once: true, capture: true});

async function playReviewChime() {
    const context = ensureNotificationAudioContext();
    if (!context) return;
    if (context.state === "suspended") {
        await context.resume();
    }
    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    gain.connect(context.destination);
    for (const [frequency, delay] of [[660, 0], [880, 0.16]]) {
        const oscillator = context.createOscillator();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        oscillator.connect(gain);
        oscillator.start(now + delay);
        oscillator.stop(now + delay + 0.28);
    }
}

function injectStyles() {
    if (document.getElementById("h3-chain-review-style")) return;
    const style = document.createElement("style");
    style.id = "h3-chain-review-style";
    style.textContent = `
        .h3r-root { box-sizing:border-box; display:flex; flex-direction:column; gap:8px;
            min-height:500px; padding:9px; overflow:auto; border:1px solid #56637e;
            border-radius:8px; background:#181a20; color:#e8eaf0; font:12px/1.35 system-ui,sans-serif; }
        .h3r-root * { box-sizing:border-box; }
        .h3r-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
        .h3r-title { font-weight:750; color:#a9c2ff; }
        .h3r-badge { color:#d5d9e3; opacity:.75; }
        .h3r-video-panel { width:100%; height:300px; min-height:140px; max-height:1200px;
            flex:0 0 auto; display:flex; flex-direction:column; overflow:hidden;
            border:1px solid #343b4b; border-radius:6px; background:#08090c; }
        .h3r-video { width:100%; height:calc(100% - 11px); min-height:0; display:block;
            flex:1 1 auto; background:#08090c; object-fit:contain; }
        .h3r-video-grip { height:11px; flex:0 0 11px; cursor:ns-resize;
            border-top:1px solid #343b4b; background:linear-gradient(180deg,#252a35,#171a21);
            position:relative; touch-action:none; }
        .h3r-video-grip::after { content:""; position:absolute; left:calc(50% - 20px); top:4px;
            width:40px; height:2px; border-top:1px solid #7e899f;
            border-bottom:1px solid #4f586b; }
        .h3r-video-grip:hover { background:linear-gradient(180deg,#313848,#1d212b); }
        .h3r-label { display:flex; flex-direction:column; gap:4px; color:#aeb5c5; }
        .h3r-prompt { width:100%; min-height:120px; resize:vertical; padding:7px;
            border:1px solid #56637e; border-radius:5px; background:#101218; color:#eef1f7; }
        .h3r-row { display:flex; align-items:flex-end; gap:7px; }
        .h3r-field { display:flex; flex-direction:column; gap:4px; min-width:0;
            color:#aeb5c5; }
        .h3r-field-seed { flex:2 1 0; }
        .h3r-field-duration { flex:1 1 0; }
        .h3r-seed { width:100%; min-width:0; padding:6px 7px; border:1px solid #56637e;
            border-radius:5px; background:#101218; color:#eef1f7; }
        .h3r-duration { width:100%; min-width:0; padding:6px 7px;
            border:1px solid #56637e; border-radius:5px; background:#101218;
            color:#eef1f7; }
        .h3r-candidates { display:flex; align-items:center; gap:7px; padding:7px;
            border:1px solid #4c6388; border-radius:6px; background:#172033; }
        .h3r-candidate-label { flex:0 0 auto; color:#a9c2ff; font-weight:700; }
        .h3r-candidate-select { flex:1; min-width:0; padding:6px 7px;
            border:1px solid #637aa2; border-radius:5px; background:#101827;
            color:#eef1f7; }
        .h3r-candidate-help { flex:0 0 auto; color:#9ca8bc; font-size:10px; }
        .h3r-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; }
        .h3r-button { padding:7px; border:1px solid #63708b; border-radius:5px;
            background:#292e3a; color:#eef1f7; cursor:pointer; }
        .h3r-button:hover { background:#343b4b; }
        .h3r-button:disabled { opacity:.42; cursor:not-allowed; }
        .h3r-button:disabled:hover { background:#292e3a; }
        .h3r-approve { border-color:#4b9d72; background:#204332; }
        .h3r-retry { border-color:#b58b45; background:#4a3820; }
        .h3r-stop { border-color:#8a6171; background:#3b252d; }
        .h3r-status { min-height:18px; color:#aeb5c5; white-space:pre-wrap; }
        .h3r-warning { color:#f2bd67; }
        .h3r-prefix { margin:0; padding:6px 7px; max-height:90px; overflow:auto;
            border-left:2px solid #56637e; color:#aeb5c5; white-space:pre-wrap; }
        .h3r-resume { display:flex; flex-direction:column; gap:6px; margin-top:2px;
            padding:8px; border:1px solid #3f4759; border-radius:6px; background:#14161c; }
        .h3r-resume-title { font-weight:700; color:#a9c2ff; }
        .h3r-resume-row { display:flex; gap:6px; align-items:center; }
        .h3r-resume-select { flex:1; min-width:0; padding:6px; border:1px solid #56637e;
            border-radius:5px; background:#101218; color:#eef1f7; }
        .h3r-resume-status { color:#8f98aa; white-space:pre-wrap; }
        .h3r-revisions { display:flex; flex-direction:column; gap:6px; padding-top:4px;
            border-top:1px solid #343b4b; }
        .h3r-revisions-title { font-weight:650; color:#c3cad8; }
        .h3r-revision-rows { display:flex; flex-direction:column; gap:6px; }
        .h3r-revision-row { display:grid; grid-template-columns:auto minmax(0,1fr) auto;
            gap:6px; align-items:center; }
        .h3r-revision-label { min-width:54px; color:#aeb5c5; }
        .h3r-revision-select { min-width:0; padding:6px; border:1px solid #56637e;
            border-radius:5px; background:#101218; color:#eef1f7; }
        .h3r-delete { border-color:#8a6171; background:#3b252d; }
        .h3r-root.h3r-busy .h3r-actions .h3r-button { opacity:.45; pointer-events:none; }
    `;
    document.head.appendChild(style);
}

function nodeType(node) {
    return node?.comfyClass ?? node?.type ?? null;
}

function findNodeByQualifiedId(qid) {
    if (!app.graph || qid == null) return null;
    const parts = String(qid).split(":");
    let graph = app.graph;
    for (let i = 0; i < parts.length - 1; i += 1) {
        const id = Number(parts[i]);
        const parent = Number.isFinite(id) ? graph?.getNodeById?.(id) : null;
        if (!parent?.subgraph) return null;
        graph = parent.subgraph;
    }
    const leaf = Number(parts.at(-1));
    return Number.isFinite(leaf) ? graph?.getNodeById?.(leaf) ?? null : null;
}

function allNodes(graph, output = []) {
    for (const node of graph?._nodes ?? []) {
        output.push(node);
        if (node.subgraph) allNodes(node.subgraph, output);
    }
    return output;
}

function findUpstreamNode(start, wantedType) {
    const queue = [start];
    const seen = new Set();
    while (queue.length) {
        const node = queue.shift();
        if (!node || seen.has(node)) continue;
        seen.add(node);
        if (node !== start && nodeType(node) === wantedType) return node;
        for (const input of node.inputs ?? []) {
            if (input.link == null) continue;
            const link = node.graph?.links?.[input.link];
            const parent = link ? node.graph?.getNodeById?.(link.origin_id) : null;
            if (parent) queue.push(parent);
        }
    }
    return null;
}

function videoUrl(item) {
    const query = new URLSearchParams({
        filename: item.filename,
        subfolder: item.subfolder ?? "",
        type: item.type ?? "output",
    });
    return api.apiURL(`/view?${query.toString()}`);
}

function upstreamPlanNode(reviewNode) {
    return findUpstreamNode(reviewNode, PLAN_NAME) ??
        allNodes(app.graph).find((item) => nodeType(item) === PLAN_NAME);
}

function widgetByName(node, name) {
    return node?.widgets?.find((item) => item.name === name);
}

function planResumeContext(reviewNode) {
    const planNode = upstreamPlanNode(reviewNode);
    const planWidget = widgetByName(planNode, "plan_json");
    const runWidget = widgetByName(planNode, "run_name");
    if (!planWidget || !runWidget) {
        throw new Error("Connect this Review Gate to an H3 Chain Plan and Loop Start.");
    }
    const plan = parsePlanJson(String(planWidget.value ?? ""));
    const runName = String(runWidget.value ?? "").trim();
    if (!runName) throw new Error("The H3 Chain Plan run_name is empty.");
    return {runName, clipCount: plan.shots.length};
}

function updatePlan(reviewNode, index, prompt, seed, length) {
    const planNode = upstreamPlanNode(reviewNode);
    const widget = planNode?.widgets?.find((item) => item.name === "plan_json");
    if (!widget) return false;
    const sceneIndex = Number(index) - 1;
    const plan = applyReviewEdit(
        parsePlanJson(String(widget.value ?? "")), index, prompt, seed, length,
    );
    const value = planToJson(plan);
    widget.value = value;
    widget.callback?.(value);
    planNode._h3ChainEditorRefresh?.();
    planNode.graph?.setDirtyCanvas?.(true, true);
    publishCompanionPrompt(
        reviewNode,
        planNode,
        sceneIndex,
        promptValueToText(plan.shots[sceneIndex]?.prompt),
    );
    return true;
}

function planScenePrompt(reviewNode, review) {
    try {
        const planNode = upstreamPlanNode(reviewNode);
        const widget = widgetByName(planNode, "plan_json");
        if (!widget) return null;
        return reviewPlanScenePrompt(
            parsePlanJson(String(widget.value ?? "")),
            review?.clip_index,
            review?.shot_id,
        );
    } catch (_error) {
        return null;
    }
}

function updatePlanFromCheckpointRevisions(reviewNode, revisions) {
    const planNode = upstreamPlanNode(reviewNode);
    const widget = planNode?.widgets?.find((item) => item.name === "plan_json");
    if (!widget) return false;
    const plan = applyCheckpointRevisionSet(
        parsePlanJson(String(widget.value ?? "")), revisions,
    );
    const value = planToJson(plan);
    widget.value = value;
    widget.callback?.(value);
    planNode._h3ChainEditorRefresh?.();
    planNode.graph?.setDirtyCanvas?.(true, true);
    for (const revision of revisions ?? []) {
        const sceneIndex = Number(revision?.scene) - 1;
        if (sceneIndex < 0 || sceneIndex >= plan.shots.length) continue;
        publishCompanionPrompt(
            reviewNode,
            planNode,
            sceneIndex,
            promptValueToText(plan.shots[sceneIndex]?.prompt),
        );
    }
    return true;
}

function restoreSavedPlanInputs(reviewNode, inputs) {
    const planNode = upstreamPlanNode(reviewNode);
    if (!planNode || !inputs || typeof inputs !== "object") {
        throw new Error("The saved run has no Plan inputs to restore.");
    }
    const names = Object.keys(inputs).sort((left, right) =>
        Number(left === "plan_json") - Number(right === "plan_json"));
    const applied = [];
    const unavailable = [];
    const graph = planNode.graph ?? app.graph;
    graph?.beforeChange?.();
    try {
        for (const name of names) {
            const widget = widgetByName(planNode, name);
            if (!widget) {
                unavailable.push(name);
                continue;
            }
            widget.value = inputs[name];
            widget.callback?.(inputs[name]);
            applied.push(name);
        }
    } finally {
        graph?.afterChange?.();
    }
    if (!applied.includes("plan_json")) {
        throw new Error("The connected Plan does not expose an editable plan_json widget.");
    }
    const planWidget = widgetByName(planNode, "plan_json");
    const plan = parsePlanJson(String(planWidget?.value ?? ""));
    planNode._h3ChainEditorRefresh?.();
    planNode.graph?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    for (const [sceneIndex, shot] of plan.shots.entries()) {
        publishCompanionPrompt(
            reviewNode,
            planNode,
            sceneIndex,
            promptValueToText(shot.prompt),
        );
    }
    return {sceneCount: plan.shots.length, unavailable};
}

function formatBytes(value) {
    let size = Math.max(0, Number(value) || 0);
    const units = ["B", "KB", "MB", "GB", "TB"];
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
    }
    const digits = unit === 0 || size >= 100 ? 0 : size >= 10 ? 1 : 2;
    return `${size.toFixed(digits)} ${units[unit]}`;
}

function checkpointRevisionLabel(revision) {
    const active = revision.active ? "Active · " : "";
    const date = revision.createdAt
        ? new Date(revision.createdAt).toLocaleString() : "unknown time";
    const seed = revision.seed ? ` · seed ${revision.seed}` : "";
    return `${active}${date} · ${revision.revision.slice(0, 8)}${seed} · ${formatBytes(revision.sizeBytes)}`;
}

function prepareResume(reviewNode, nextIndex) {
    const startNode = findUpstreamNode(reviewNode, "MiniMaxH3ChainLoopStart") ??
        allNodes(app.graph).find((item) => nodeType(item) === "MiniMaxH3ChainLoopStart");
    const widget = startNode?.widgets?.find((item) => item.name === "start_clip");
    if (!widget) return false;
    widget.value = nextIndex;
    widget.callback?.(nextIndex);
    // An explicit range overrides start_clip in the backend. Clear it so the
    // checkpoint browser's selected resume scene is always authoritative.
    const rangeWidget = startNode.widgets?.find((item) => item.name === "scene_range");
    if (rangeWidget) {
        rangeWidget.value = "";
        rangeWidget.callback?.("");
    }
    startNode.graph?.setDirtyCanvas?.(true, true);
    return true;
}

function fetchPending() {
    if (pendingFetchPromise) return pendingFetchPromise;
    pendingFetchPromise = (async () => {
        try {
            const response = await api.fetchApi("/minimax_h3_context_loop/reviews");
            if (!response.ok) return 0;
            const body = await response.json();
            const reviews = body.reviews ?? [];
            for (const review of reviews) routeReview(review);
            return reviews.length;
        } catch (error) {
            console.warn("[H3 Chain Review] Could not recover pending reviews:", error);
            return 0;
        } finally {
            pendingFetchPromise = null;
        }
    })();
    return pendingFetchPromise;
}

function deliverReview(node, data) {
    if (!node || nodeType(node) !== NODE_NAME) return false;
    const expectedRun = String(data?.run_name ?? "").trim();
    if (expectedRun) {
        const planNode = findUpstreamNode(node, PLAN_NAME);
        const actualRun = String(widgetByName(planNode, "run_name")?.value ?? "").trim();
        if (actualRun && actualRun !== expectedRun) return false;
    }
    if (typeof node._h3ReviewHandler === "function") {
        node._h3ReviewHandler(data);
    } else {
        // A websocket event can arrive between node creation and the DOM
        // widget's deferred mount. Preserve it instead of leaving a live
        // backend future with no token in the browser.
        node._h3QueuedReview = data;
    }
    return true;
}

function reviewFallbackNode(data) {
    const gates = [...new Set([
        ...allNodes(app.graph).filter((item) => nodeType(item) === NODE_NAME),
        ...[...mountedReviewNodes].filter((item) => nodeType(item) === NODE_NAME),
    ])];
    const expectedRun = String(data?.run_name ?? "").trim();
    if (expectedRun) {
        const matchingRun = gates.filter((item) => {
            const planNode = findUpstreamNode(item, PLAN_NAME);
            return String(widgetByName(planNode, "run_name")?.value ?? "").trim() ===
                expectedRun;
        });
        if (matchingRun.length === 1) return matchingRun[0];
    }
    // GraphBuilder execution ids use dots while subgraph-qualified display
    // ids use colons. The visible LiteGraph node is always the final leaf.
    const leaf = String(data?.node_id ?? "").split(/[.:]/).at(-1);
    const matchingLeaf = gates.filter((item) => String(item.id) === leaf);
    if (matchingLeaf.length === 1) return matchingLeaf[0];
    return gates.length === 1 ? gates[0] : null;
}

function routeReview(data) {
    const exact = findNodeByQualifiedId(data?.node_id);
    if (deliverReview(exact, data)) return true;
    const fallback = reviewFallbackNode(data);
    if (deliverReview(fallback, data)) {
        console.warn(
            `[H3 Chain Review] Display node ${data?.node_id} was not directly ` +
            "resolvable; routed the pending review to the only matching gate.",
        );
        return true;
    }
    console.warn(
        `[H3 Chain Review] Pending token ${data?.token ?? "?"} could not be ` +
        `routed to display node ${data?.node_id ?? "?"}.`,
    );
    return false;
}

function routeReviewResolved(data) {
    const exact = findNodeByQualifiedId(data?.node_id);
    const node = nodeType(exact) === NODE_NAME ? exact : reviewFallbackNode(data);
    node?._h3ReviewResolvedHandler?.(data);
}

function updatePendingPolling() {
    if (mountedReviewNodes.size > 0 && pendingPollTimer == null) {
        // send_sync targets the browser session that queued the prompt. A
        // reconnect, reverse proxy, sleeping tab, or websocket race can miss
        // that event even though the backend review remains healthy. Polling
        // this tiny in-memory endpoint makes the pending token recoverable.
        pendingPollTimer = window.setInterval(() => {
            if (document.visibilityState !== "hidden") fetchPending();
        }, 2000);
    } else if (mountedReviewNodes.size === 0 && pendingPollTimer != null) {
        window.clearInterval(pendingPollTimer);
        pendingPollTimer = null;
    }
}

function mount(node) {
    if (node._h3ReviewMounted || typeof node.addDOMWidget !== "function") return;
    node._h3ReviewMounted = true;
    injectStyles();

    const root = document.createElement("div");
    root.className = "h3r-root";
    root.title = "Review each persisted H3 scene with synchronized sound, then approve, retry, reroll, stop, or arm a saved checkpoint for resume.";
    // LiteGraph listens to pointer events on the canvas. Shield the complete
    // pointer sequence, not only mousedown: Firefox can otherwise let the
    // canvas capture pointerdown before a DOM-widget button receives click.
    for (const eventName of [
        "pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick",
    ]) {
        root.addEventListener(eventName, (event) => event.stopPropagation());
    }
    root.addEventListener("wheel", (event) => event.stopPropagation());

    const head = document.createElement("div");
    head.className = "h3r-head";
    const title = document.createElement("span");
    title.className = "h3r-title";
    title.textContent = "H3 Segment Review";
    const badge = document.createElement("span");
    badge.className = "h3r-badge";
    badge.textContent = "waiting for segment…";
    head.append(title, badge);

    const video = document.createElement("video");
    video.className = "h3r-video";
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.title = "Saved delivered scene preview. Review motion, continuity, and synchronized audio before choosing an action.";
    const videoPanel = document.createElement("div");
    videoPanel.className = "h3r-video-panel";
    videoPanel.title = "Resizable saved-scene preview.";
    const videoGrip = document.createElement("div");
    videoGrip.className = "h3r-video-grip";
    videoGrip.title = "Drag vertically to resize the video preview. Double-click to reset.";
    videoGrip.setAttribute("role", "separator");
    videoGrip.setAttribute("aria-label", "Resize video preview");
    videoGrip.setAttribute("aria-orientation", "horizontal");
    videoPanel.append(video, videoGrip);

    node.properties ??= {};
    const savedVideoHeight = Number(node.properties[VIDEO_HEIGHT_PROPERTY]);
    const initialVideoHeight = Number.isFinite(savedVideoHeight)
        ? Math.max(MIN_VIDEO_HEIGHT, Math.min(MAX_VIDEO_HEIGHT, savedVideoHeight))
        : DEFAULT_VIDEO_HEIGHT;
    videoPanel.style.height = `${initialVideoHeight}px`;

    let videoResize = null;
    function setVideoHeight(height, persist = false) {
        const next = Math.round(Math.max(
            MIN_VIDEO_HEIGHT,
            Math.min(MAX_VIDEO_HEIGHT, Number(height) || DEFAULT_VIDEO_HEIGHT),
        ));
        videoPanel.style.height = `${next}px`;
        videoGrip.setAttribute("aria-valuenow", String(next));
        if (persist) {
            node.properties[VIDEO_HEIGHT_PROPERTY] = next;
            node.graph?.setDirtyCanvas?.(true, true);
            app.graph?.setDirtyCanvas?.(true, true);
        }
    }
    setVideoHeight(initialVideoHeight);
    videoGrip.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        const layoutHeight = videoPanel.offsetHeight;
        const visualHeight = videoPanel.getBoundingClientRect().height;
        const displayScale = layoutHeight > 0 && visualHeight > 0
            ? visualHeight / layoutHeight : 1;
        videoResize = {
            pointerId: event.pointerId,
            startY: event.clientY,
            startHeight: layoutHeight || DEFAULT_VIDEO_HEIGHT,
            displayScale,
        };
        videoGrip.setPointerCapture?.(event.pointerId);
    });
    videoGrip.addEventListener("pointermove", (event) => {
        if (!videoResize || event.pointerId !== videoResize.pointerId) return;
        event.preventDefault();
        setVideoHeight(videoResize.startHeight
            + (event.clientY - videoResize.startY) / videoResize.displayScale);
    });
    function finishVideoResize(event) {
        if (!videoResize || event.pointerId !== videoResize.pointerId) return;
        videoResize = null;
        // offsetHeight is an unscaled layout value. getBoundingClientRect()
        // includes ComfyUI canvas zoom and caused every release to compound a
        // smaller screen-space height into the saved CSS height.
        setVideoHeight(videoPanel.offsetHeight, true);
        videoGrip.releasePointerCapture?.(event.pointerId);
    }
    videoGrip.addEventListener("pointerup", finishVideoResize);
    videoGrip.addEventListener("pointercancel", finishVideoResize);
    videoGrip.addEventListener("dblclick", (event) => {
        event.preventDefault();
        setVideoHeight(DEFAULT_VIDEO_HEIGHT, true);
    });

    const prefix = document.createElement("pre");
    prefix.className = "h3r-prefix";
    prefix.hidden = true;
    prefix.title = "Shared prompt prepended to every scene. It is shown for context and is not changed by retrying this scene.";

    const promptLabel = document.createElement("label");
    promptLabel.className = "h3r-label";
    promptLabel.append("Scene prompt (used when retrying)");
    const prompt = document.createElement("textarea");
    prompt.className = "h3r-prompt";
    prompt.title = "The connected Prompt Editor and this fallback field share the current Plan scene. Retry regenerates it from the same accepted predecessor.";
    promptLabel.append(prompt);
    let promptEditedInGate = false;
    prompt.addEventListener("input", () => { promptEditedInGate = true; });

    let promptResizeObserver = null;
    function applySavedLayout() {
        node.properties ??= {};
        const restoredVideoHeight = Number(node.properties[VIDEO_HEIGHT_PROPERTY]);
        setVideoHeight(Number.isFinite(restoredVideoHeight)
            ? restoredVideoHeight : DEFAULT_VIDEO_HEIGHT);
        const restoredPromptHeight = Number(node.properties[PROMPT_HEIGHT_PROPERTY]);
        if (Number.isFinite(restoredPromptHeight) && restoredPromptHeight >= 120) {
            prompt.style.height = `${Math.round(restoredPromptHeight)}px`;
        } else {
            prompt.style.removeProperty("height");
        }
    }
    if (typeof ResizeObserver === "function") {
        let initialized = false;
        promptResizeObserver = new ResizeObserver(() => {
            if (!prompt.isConnected) return;
            const next = Math.round(prompt.offsetHeight);
            if (!Number.isFinite(next) || next < 120) return;
            if (!initialized) {
                initialized = true;
                return;
            }
            if (Number(node.properties?.[PROMPT_HEIGHT_PROPERTY]) === next) return;
            node.properties ??= {};
            node.properties[PROMPT_HEIGHT_PROPERTY] = next;
            node.graph?.setDirtyCanvas?.(true, true);
            app.graph?.setDirtyCanvas?.(true, true);
        });
        promptResizeObserver.observe(prompt);
    }
    node._h3ReviewApplyLayout = applySavedLayout;
    applySavedLayout();

    const seedRow = document.createElement("div");
    seedRow.className = "h3r-row";
    const seedField = document.createElement("label");
    seedField.className = "h3r-field h3r-field-seed";
    seedField.append("Seed");
    const seed = document.createElement("input");
    seed.className = "h3r-seed";
    seed.inputMode = "numeric";
    seed.title = "Unsigned 64-bit seed for the current scene. Edit it before Retry, or use Reroll seed to generate a new value automatically.";
    seedField.append(seed);
    const durationField = document.createElement("label");
    durationField.className = "h3r-field h3r-field-duration";
    durationField.append("Duration (s)");
    const duration = document.createElement("input");
    duration.className = "h3r-duration";
    duration.type = "number";
    duration.inputMode = "decimal";
    duration.min = String(5 / 24);
    duration.max = String(3592 / 24);
    duration.step = String(17 / 24);
    duration.title = "Generated scene duration. Retry and Reroll round this upward to H3's exact 17k+5 frame grid, revise the full Plan, and retime downstream scenes. Prompt wording and written timestamps are not changed.";
    durationField.append(duration);
    seedRow.append(seedField, durationField);

    const candidateRow = document.createElement("div");
    candidateRow.className = "h3r-candidates";
    candidateRow.hidden = true;
    const candidateLabel = document.createElement("span");
    candidateLabel.className = "h3r-candidate-label";
    candidateLabel.textContent = "Choose take";
    const candidateSelect = document.createElement("select");
    candidateSelect.className = "h3r-candidate-select";
    candidateSelect.title = "Preview each generated take. The selected checkpoint, including its exact video and audio continuation tensors, becomes the active scene when you approve.";
    const candidateHelp = document.createElement("span");
    candidateHelp.className = "h3r-candidate-help";
    candidateHelp.textContent = "exact checkpoint";
    candidateRow.append(candidateLabel, candidateSelect, candidateHelp);

    const actions = document.createElement("div");
    actions.className = "h3r-actions";
    const actionButtons = [];
    function actionButton(label, className, action) {
        const button = document.createElement("button");
        button.className = `h3r-button ${className}`;
        button.textContent = label;
        button.type = "button";
        button.title = {
            approve: "Accept this saved scene and continue the loop with the next scene.",
            retry: "Reject this attempt and regenerate the same scene using the edited prompt, seed, and duration.",
            reroll: "Reject this attempt, assign a new random seed, and regenerate the same scene using the edited prompt and duration.",
            stop: "Accept this scene but stop before the next one. Optionally assemble a partial joined MP4 and arm the next scene for resume.",
        }[action] ?? "Submit this review decision.";
        // Keep actions clickable while waiting. If a websocket event or node-id
        // route was missed, submit() can recover the live token through the
        // pending-review endpoint and perform the requested action immediately.
        button.disabled = false;
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void submit(action);
        });
        actions.append(button);
        actionButtons.push(button);
        return button;
    }
    const approveButton = actionButton(
        "Approve & continue", "h3r-approve", "approve");
    actionButton("Retry prompt / seed / length", "h3r-retry", "retry");
    actionButton("Reroll seed", "h3r-retry", "reroll");
    actionButton("Approve & stop", "h3r-stop", "stop");

    const status = document.createElement("div");
    status.className = "h3r-status";
    status.textContent = "The loop will pause here after each saved segment.";

    const resume = document.createElement("section");
    resume.className = "h3r-resume";
    const resumeTitle = document.createElement("div");
    resumeTitle.className = "h3r-resume-title";
    resumeTitle.textContent = "Resume from saved checkpoint";
    const resumeRow = document.createElement("div");
    resumeRow.className = "h3r-resume-row";
    const resumeSelect = document.createElement("select");
    resumeSelect.className = "h3r-resume-select";
    resumeSelect.title = "Choose the next scene to render. Its immediately preceding saved checkpoint supplies the visual and AV continuation state.";
    const refreshResume = document.createElement("button");
    refreshResume.type = "button";
    refreshResume.className = "h3r-button";
    refreshResume.textContent = "Refresh";
    refreshResume.title = "Scan this run's checkpoint folder again and list valid resume positions.";
    const loadResume = document.createElement("button");
    loadResume.type = "button";
    loadResume.className = "h3r-button h3r-approve";
    loadResume.textContent = "Load checkpoint";
    loadResume.title = "Restore the saved run's full Plan, preview the selected predecessor checkpoint, and set H3 Chain Loop Start to the chosen resume scene. Queue the workflow afterward to actually resume.";
    const resumeStatus = document.createElement("div");
    resumeStatus.className = "h3r-resume-status";
    resumeStatus.textContent = "Refresh to discover saved scenes for this run.";
    const revisionsPanel = document.createElement("div");
    revisionsPanel.className = "h3r-revisions";
    revisionsPanel.hidden = true;
    const revisionsTitle = document.createElement("div");
    revisionsTitle.className = "h3r-revisions-title";
    revisionsTitle.textContent = "Checkpoint history";
    const revisionsHint = document.createElement("div");
    revisionsHint.className = "h3r-resume-status";
    revisionsHint.textContent = "All saved scenes are listed. Only scenes before the selected resume position are restored.";
    const revisionsRows = document.createElement("div");
    revisionsRows.className = "h3r-revision-rows";
    revisionsPanel.append(revisionsTitle, revisionsHint, revisionsRows);
    resumeRow.append(resumeSelect, refreshResume, loadResume);
    resume.append(resumeTitle, resumeRow, resumeStatus, revisionsPanel);

    root.append(head, videoPanel, prefix, promptLabel, seedRow, candidateRow,
        actions, status, resume);

    let current = null;
    let countdownTimer = null;
    let resumeChoices = [];
    let checkpointRevisions = [];
    let revisionChain = [];
    let planClipCount = 0;
    let resumeRefreshToken = 0;

    function setActionsEnabled(enabled) {
        for (const button of actionButtons) button.disabled = !enabled;
    }

    function selectedCandidate() {
        const candidates = Array.isArray(current?.candidates)
            ? current.candidates : [];
        return candidates.find(
            (candidate) => candidate.revision === candidateSelect.value,
        ) ?? candidates.at(-1) ?? null;
    }

    function showCandidate(candidate, announce = false) {
        if (!candidate) return;
        if (candidate.video) {
            video.src = videoUrl(candidate.video);
            video.load();
        }
        seed.value = String(candidate.seed ?? seed.value);
        badge.textContent = `clip ${current.clip_index}/${current.clip_count} · ` +
            `candidate ${candidate.number}/${current.candidate_count} · ${current.shot_id}`;
        if (announce) {
            status.className = `h3r-status${candidate.warning ? " h3r-warning" : ""}`;
            status.textContent = candidate.warning ||
                `Previewing candidate ${candidate.number}/${current.candidate_count}, seed ${candidate.seed}.`;
        }
    }

    function renderCandidateChoices() {
        const previous = candidateSelect.value;
        const candidates = Array.isArray(current?.candidates)
            ? current.candidates : [];
        const multiple = Number(current?.candidate_count) > 1 && candidates.length > 1;
        candidateRow.hidden = !multiple;
        approveButton.textContent = multiple
            ? "Use selected take & continue" : "Approve & continue";
        candidateSelect.replaceChildren();
        if (!multiple) return null;
        for (const candidate of candidates) {
            const option = document.createElement("option");
            option.value = candidate.revision;
            option.textContent = `Candidate ${candidate.number}/${current.candidate_count} · ` +
                `seed ${candidate.seed} · ${candidate.revision.slice(0, 8)}`;
            candidateSelect.append(option);
        }
        candidateSelect.value = candidates.some(
            (candidate) => candidate.revision === previous,
        ) ? previous : candidates.at(-1).revision;
        return selectedCandidate();
    }

    candidateSelect.addEventListener("change", () => {
        showCandidate(selectedCandidate(), true);
    });

    function selectedRevisionChain() {
        const selectedResumeScene = Number(resumeSelect.value);
        if (!Number.isInteger(selectedResumeScene) || selectedResumeScene < 2) {
            return [];
        }
        return revisionChain.map((group) => {
            const select = revisionsRows.querySelector(
                `select[data-scene="${group.scene}"]`,
            );
            const revision = group.revisions.find(
                (item) => item.revision === select?.value,
            );
            return revision ?? group.revisions[0];
        }).filter((revision) => revision.scene < selectedResumeScene);
    }

    function showRevisionPreview(revision) {
        if (!revision?.video) return;
        video.src = videoUrl(revision.video);
        video.load();
        badge.textContent = `saved scene ${revision.scene} · revision ${revision.revision.slice(0, 8)}`;
    }

    async function deleteRevision(revision) {
        if (!revision || revision.active) return;
        try {
            const context = planResumeContext(node);
            const previewResponse = await api.fetchApi(
                "/minimax_h3_context_loop/checkpoint-revisions/delete-preview", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({
                        run_name: context.runName,
                        scene: revision.scene,
                        revision: revision.revision,
                    }),
                },
            );
            const preview = await previewResponse.json();
            if (!previewResponse.ok) {
                throw new Error(preview.error || `HTTP ${previewResponse.status}`);
            }
            if (!preview.allowed) {
                throw new Error((preview.blockers ?? []).join(" ") ||
                    "This checkpoint revision cannot be deleted safely.");
            }
            const confirmed = window.confirm(
                `Permanently delete scene ${revision.scene} revision ` +
                `${revision.revision.slice(0, 8)} and its ` +
                `${preview.owned_file_count} owned files ` +
                `(${formatBytes(preview.reclaimed_bytes)})? Run archives, ` +
                "references, prompt history, and assembled exports are kept. " +
                "This cannot be undone.",
            );
            if (!confirmed) return;
            const response = await api.fetchApi(
                "/minimax_h3_context_loop/checkpoint-revisions/delete", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({
                        run_name: context.runName,
                        scene: revision.scene,
                        revision: revision.revision,
                        snapshot: preview.snapshot,
                    }),
                },
            );
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
            await refreshResumeOptions();
            resumeStatus.textContent = `${body.message} Reclaimed ${formatBytes(body.reclaimed_bytes)}.`;
        } catch (error) {
            resumeStatus.textContent = error.message;
        }
    }

    function renderRevisionChoices() {
        revisionsRows.replaceChildren();
        revisionChain = checkpointRevisionChain(
            checkpointRevisions, planClipCount + 1,
        );
        const hasHistory = revisionChain.length > 0;
        revisionsPanel.hidden = !hasHistory;
        if (!hasHistory) {
            loadResume.textContent = "Load checkpoint";
            return;
        }
        for (const group of revisionChain) {
            const row = document.createElement("div");
            row.className = "h3r-revision-row";
            const label = document.createElement("span");
            label.className = "h3r-revision-label";
            label.textContent = `Scene ${group.scene}`;
            const select = document.createElement("select");
            select.className = "h3r-revision-select";
            select.dataset.scene = String(group.scene);
            for (const revision of group.revisions) {
                const option = document.createElement("option");
                option.value = revision.revision;
                option.textContent = checkpointRevisionLabel(revision);
                select.append(option);
            }
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "h3r-button h3r-delete";
            remove.textContent = "Delete";
            remove.title = "Permanently delete the selected inactive revision and only its owned files.";
            const update = (preview = false) => {
                const revision = group.revisions.find(
                    (item) => item.revision === select.value,
                );
                remove.disabled = !revision || revision.active;
                loadResume.textContent = selectedRevisionChain().some(
                    (item) => !item.active,
                ) ? "Restore & load" : "Load checkpoint";
                if (preview) showRevisionPreview(revision);
            };
            select.addEventListener("change", () => update(true));
            remove.addEventListener("click", () => {
                const revision = group.revisions.find(
                    (item) => item.revision === select.value,
                );
                void deleteRevision(revision);
            });
            row.append(label, select, remove);
            revisionsRows.append(row);
            update();
        }
    }

    async function refreshResumeOptions() {
        const refreshToken = ++resumeRefreshToken;
        const previousResumeScene = Number(resumeSelect.value);
        resumeSelect.replaceChildren();
        resumeChoices = [];
        checkpointRevisions = [];
        revisionChain = [];
        revisionsRows.replaceChildren();
        revisionsPanel.hidden = true;
        loadResume.disabled = true;
        try {
            const context = planResumeContext(node);
            planClipCount = context.clipCount;
            const query = new URLSearchParams({run_name: context.runName});
            const response = await api.fetchApi(
                `/minimax_h3_context_loop/checkpoints?${query.toString()}`,
            );
            const body = await response.json();
            if (refreshToken !== resumeRefreshToken) return;
            if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
            resumeChoices = checkpointResumeOptions(
                body.checkpoints, context.clipCount);
            checkpointRevisions = body.revisions ?? [];
            for (const option of resumeChoices) {
                const element = document.createElement("option");
                element.value = String(option.resumeScene);
                element.textContent = `Resume scene ${option.resumeScene} — checkpoint ${option.savedScene} · ${option.sceneId}`;
                resumeSelect.append(element);
            }
            if (resumeChoices.some(
                    (option) => option.resumeScene === previousResumeScene)) {
                resumeSelect.value = String(previousResumeScene);
            }
            renderRevisionChoices();
            loadResume.disabled = resumeChoices.length === 0;
            const complete = (body.checkpoints ?? []).filter((item) => item.ready).length;
            resumeStatus.textContent = resumeChoices.length
                ? `${complete} saved checkpoint${complete === 1 ? "" : "s"} found. Select the scene to resume.`
                : complete >= context.clipCount
                    ? `All ${context.clipCount} scenes are saved; there is no later scene to resume.`
                    : "No usable predecessor checkpoint was found for a later scene.";
        } catch (error) {
            if (refreshToken !== resumeRefreshToken) return;
            resumeStatus.textContent = error.message;
        }
    }

    refreshResume.addEventListener("click", refreshResumeOptions);
    resumeSelect.addEventListener("change", renderRevisionChoices);
    node._h3RefreshResume = refreshResumeOptions;
    loadResume.addEventListener("click", async () => {
        const resumeScene = Number(resumeSelect.value);
        if (!Number.isInteger(resumeScene)) return;
        try {
            const context = planResumeContext(node);
            const selections = selectedRevisionChain();
            const changed = selections.some((item) => !item.active);
            let restored = [];
            if (changed) {
                const changedScenes = selections.filter(
                    (item) => !item.active,
                ).map((item) => item.scene).join(", ");
                const confirmed = window.confirm(
                    `Restore the selected checkpoint revisions through scene ` +
                    `${resumeScene - 1} (changed scenes: ${changedScenes})? ` +
                    "The current revisions will remain available in revision history.",
                );
                if (!confirmed) return;
            }
            const runQuery = new URLSearchParams({
                run_name: context.runName,
                include_assets: "false",
            });
            const runResponse = await api.fetchApi(
                `/minimax_h3_context_loop/run?${runQuery.toString()}`,
            );
            const runBody = await runResponse.json();
            if (!runResponse.ok) throw new Error(
                runBody.error || `HTTP ${runResponse.status}`,
            );
            if (selections.length) {
                const response = await api.fetchApi(
                    "/minimax_h3_context_loop/checkpoint-revisions/restore", {
                        method: "POST",
                        headers: {"Content-Type": "application/json"},
                        body: JSON.stringify({
                            run_name: context.runName,
                            resume_scene: resumeScene,
                            revisions: selections.map((item) => ({
                                scene: item.scene,
                                revision: item.revision,
                            })),
                        }),
                    },
                );
                const body = await response.json();
                if (!response.ok) throw new Error(
                    body.error || `HTTP ${response.status}`,
                );
                restored = body.restored ?? [];
            }
            const savedPlan = restoreSavedPlanInputs(node, runBody.plan_inputs);
            if (savedPlan.sceneCount < resumeScene) {
                throw new Error(
                    `The saved Plan has ${savedPlan.sceneCount} scenes and cannot resume scene ${resumeScene}.`,
                );
            }
            if (restored.length &&
                    !updatePlanFromCheckpointRevisions(node, restored)) {
                throw new Error(
                    "Checkpoint files were restored, but the connected Plan editor could not be updated.",
                );
            }
            if (!prepareResume(node, resumeScene)) {
                throw new Error("Could not find the connected H3 Chain Loop Start node.");
            }
            const choice = resumeChoices.find(
                (item) => item.resumeScene === resumeScene);
            const selectedPredecessor = selections.find(
                (item) => item.scene === resumeScene - 1,
            );
            const preview = selectedPredecessor?.video
                ?? choice?.partialVideo ?? choice?.video;
            if (preview) {
                video.src = videoUrl(preview);
                video.load();
                badge.textContent = selectedPredecessor
                    ? `saved scene ${selectedPredecessor.scene} · revision ${selectedPredecessor.revision.slice(0, 8)}`
                    : choice?.partialVideo
                    ? `partial through checkpoint ${choice.savedScene}`
                    : `saved scene ${choice.savedScene} · ${choice.sceneId}`;
            }
            const unavailable = savedPlan.unavailable.length
                ? ` Current Plan has no ${savedPlan.unavailable.join(", ")} control. ` : " ";
            const finalStatus = `Restored the saved ${savedPlan.sceneCount}-scene Plan and ${restored.length} checkpoint scene${restored.length === 1 ? "" : "s"}.` +
                unavailable + `Checkpoint ${resumeScene - 1} loaded for preview. Loop Start is armed for scene ${resumeScene}; queue the workflow to validate and resume.`;
            if (changed) await refreshResumeOptions();
            resumeStatus.textContent = finalStatus;
        } catch (error) {
            resumeStatus.textContent = error.message;
        }
    });

    function stopCountdown() {
        if (countdownTimer != null) clearInterval(countdownTimer);
        countdownTimer = null;
    }

    function renderWaitingStatus() {
        if (!current) return;
        const message = current.warning || (Number(current.candidate_count) > 1
            ? `All ${current.candidate_count} candidates are saved. Preview them and choose the checkpoint that should continue the chain.`
            : "Review the synchronized picture and sound, then choose an action.");
        const countdown = reviewCountdown(current.local_deadline);
        status.className = `h3r-status${current.warning ? " h3r-warning" : ""}`;
        status.textContent = countdown ?
            `${message}\nAuto-continue in ${countdown.text}.` : message;
        if (countdown?.seconds === 0) {
            root.classList.add("h3r-busy");
            setActionsEnabled(false);
            status.textContent = `${message}\nTimeout reached — continuing…`;
            stopCountdown();
        }
    }

    function startCountdown() {
        stopCountdown();
        renderWaitingStatus();
        if (reviewCountdown(current?.local_deadline)?.seconds > 0) {
            countdownTimer = setInterval(renderWaitingStatus, 250);
        }
    }

    async function submit(action) {
        if (!current?.token) {
            status.className = "h3r-status h3r-warning";
            status.textContent = "No live review token is attached. Checking the server…";
            await fetchPending();
            if (!current?.token) {
                status.textContent = "No pending review is available for this project yet.";
                return;
            }
        }
        try {
            // Freeze one coherent review edit before yielding to the server.
            // Websocket recovery can replace `current`, and a companion UI can
            // refresh the live controls, while this request is in flight.
            const submittedReview = current;
            const submittedToken = submittedReview.token;
            const submittedIndex = submittedReview.clip_index;
            const submittedCandidate = selectedCandidate();
            const submittedPrompt = promptEditedInGate
                ? prompt.value
                : (planScenePrompt(node, submittedReview) ?? prompt.value);
            const normalizedSeed = action === "retry" ? reviewSeed(seed.value) : seed.value;
            const normalizedDuration = action === "retry" || action === "reroll"
                ? reviewDuration(duration.value) : null;
            stopCountdown();
            root.classList.add("h3r-busy");
            setActionsEnabled(false);
            status.className = "h3r-status";
            status.textContent = action === "approve" ? "Sending approval…" :
                action === "stop" ? "Sending stop decision…" : "Sending retry decision…";
            const response = await api.fetchApi("/minimax_h3_context_loop/review", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    token: submittedToken,
                    action,
                    scene_prompt: submittedPrompt,
                    seed: normalizedSeed,
                    length: normalizedDuration?.length,
                    candidate_revision: (action === "approve" || action === "stop") &&
                            Number(submittedReview.candidate_count) > 1
                        ? submittedCandidate?.revision ?? "" : "",
                }),
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
            if (action === "approve") {
                const selected = Number(body.candidate_count) > 1;
                const saved = selected && updatePlan(
                    node, submittedIndex, body.scene_prompt, body.seed, body.length);
                status.textContent = submittedReview.unload_models_while_waiting
                    ? "Approval received — workflow is resuming and reloading the model stack."
                    : "Approval received — workflow resumed.";
                if (selected) {
                    status.textContent += ` Candidate ${body.candidate_number}/${body.candidate_count} is now active.` +
                        (saved ? " The Plan seed was updated." : "");
                }
            } else if (action === "retry" || action === "reroll") {
                const acceptedPrompt = typeof body.scene_prompt === "string"
                    ? body.scene_prompt : submittedPrompt.trim();
                const acceptedDuration = reviewDurationText(body.length);
                const saved = updatePlan(
                    node, submittedIndex, acceptedPrompt, body.seed, body.length);
                if (current?.token === submittedToken) {
                    prompt.value = acceptedPrompt;
                    promptEditedInGate = false;
                    seed.value = body.seed;
                    duration.value = acceptedDuration;
                }
                status.textContent = `Retrying scene with seed ${body.seed} at ${body.length} frames (${acceptedDuration}s).` +
                    (saved ? " The Plan editor was updated." : "");
            } else if (action === "stop") {
                const selected = Number(body.candidate_count) > 1;
                const saved = selected && updatePlan(
                    node, submittedIndex, body.scene_prompt, body.seed, body.length);
                const prepared = submittedReview.clip_index < submittedReview.clip_count &&
                    prepareResume(node, submittedReview.clip_index + 1);
                status.textContent = (submittedReview.assemble_partial_on_stop
                    ? "Stop accepted — assembling the partial video…"
                    : "Stopped at the accepted checkpoint.") +
                    (selected ? ` Candidate ${body.candidate_number}/${body.candidate_count} is now active.` : "") +
                    (saved ? " The Plan seed was updated." : "") +
                    (prepared ? ` Loop Start is ready at clip ${submittedReview.clip_index + 1}.` : "");
                setTimeout(refreshResumeOptions, 0);
            }
        } catch (error) {
            root.classList.remove("h3r-busy");
            setActionsEnabled(Boolean(current?.token));
            status.className = "h3r-status h3r-warning";
            status.textContent = error.message;
            if (reviewCountdown(current?.local_deadline)?.seconds > 0) {
                countdownTimer = setInterval(renderWaitingStatus, 250);
            }
        }
    }

    node._h3ReviewHandler = (data) => {
        const sameToken = Boolean(current?.token) && current.token === data?.token;
        const previousRevision = Number(current?.preview_revision ?? 0);
        const incomingRevision = Number(data?.preview_revision ?? 0);
        if (sameToken && incomingRevision <= previousRevision) return;
        const localDeadline = sameToken ? current.local_deadline :
            reviewLocalDeadline(data?.deadline, data?.server_now);
        current = sameToken ? {
            ...current,
            ...data,
            local_deadline: current.local_deadline,
        } : {
            ...data,
            local_deadline: localDeadline,
        };
        if (!sameToken) {
            root.classList.remove("h3r-busy");
            setActionsEnabled(true);
            // The scene is persisted before Review Gate receives its token.
            // Refresh here so the current (including final) checkpoint appears
            // in history without requiring the user to press Refresh.
            setTimeout(refreshResumeOptions, 0);
        }
        if (!sameToken) {
            prompt.value = data.scene_prompt ?? "";
            promptEditedInGate = false;
            seed.value = data.seed ?? "";
            duration.value = reviewDurationText(data.raw_frames);
            prefix.textContent = data.prompt_prefix ?
                `Shared prompt (unchanged)\n${data.prompt_prefix}` : "";
            prefix.hidden = !data.prompt_prefix;
            startCountdown();
            if (data.play_notification_sound && !notifiedTokens.has(data.token)) {
                notifiedTokens.add(data.token);
                playReviewChime().catch((error) => {
                    console.warn("[H3 Chain Review] Browser blocked notification sound:", error);
                });
            }
        } else if (!root.classList.contains("h3r-busy")) {
            renderWaitingStatus();
        }
        const candidate = renderCandidateChoices();
        if (candidate) {
            showCandidate(candidate);
        } else {
            badge.textContent = `clip ${data.clip_index}/${data.clip_count} · ${data.shot_id}`;
            video.src = videoUrl(data.video);
            video.load();
        }
        const planNode = upstreamPlanNode(node);
        if (planNode) {
            publishPlanCompanionScene(node, planNode, Number(data.clip_index) - 1);
        }
    };

    node._h3PromptCompanionSetScenePrompt = (planNode, index, text) => {
        if (root.classList.contains("h3r-busy")
                || planNode !== upstreamPlanNode(node)
                || Number(index) !== Number(current?.clip_index) - 1) {
            return false;
        }
        prompt.value = String(text ?? "").replace(/\r\n?/g, "\n");
        promptEditedInGate = false;
        return true;
    };

    node._h3ReviewResolvedHandler = (data) => {
        if (!current || data?.token !== current.token) return;
        stopCountdown();
        root.classList.add("h3r-busy");
        setActionsEnabled(false);
        status.className = "h3r-status";
        status.textContent = data.status || "Review resolved; continuing…";
        const completedVideo = data.final_video ?? data.partial_video;
        if (completedVideo) {
            video.src = videoUrl(completedVideo);
            video.load();
            badge.textContent = data.final_video
                ? "final assembled video"
                : "partial joined video";
        }
        if (data.action === "approve" || data.action === "stop") {
            setTimeout(refreshResumeOptions, 0);
        }
    };

    const widget = node.addDOMWidget("h3_chain_review", "h3-chain-review", root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 500,
    });
    widget.serialize = false;
    mountedReviewNodes.add(node);
    updatePendingPolling();
    const removed = node.onRemoved;
    node.onRemoved = function () {
        stopCountdown();
        promptResizeObserver?.disconnect();
        delete this._h3PromptCompanionSetScenePrompt;
        mountedReviewNodes.delete(this);
        updatePendingPolling();
        return removed?.apply(this, arguments);
    };
    node.setSize?.([Math.max(node.size?.[0] ?? 540, 540), Math.max(node.size?.[1] ?? 650, 650)]);
    const queuedReview = node._h3QueuedReview;
    delete node._h3QueuedReview;
    if (queuedReview) node._h3ReviewHandler(queuedReview);
    setTimeout(fetchPending, 0);
    setTimeout(refreshResumeOptions, 0);
}

api.addEventListener("minimax_h3_context_loop_review", (event) => routeReview(event.detail));
api.addEventListener("minimax_h3_context_loop_review_resolved", (event) =>
    routeReviewResolved(event.detail));
// A status event is sent when ComfyUI's websocket connects or reconnects.
api.addEventListener("status", fetchPending);
window.addEventListener("focus", fetchPending);
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") fetchPending();
});

app.registerExtension({
    name: "minimax_h3_context_loop.chain_review",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            setTimeout(() => mount(this), 0);
            return result;
        };
        const configured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = configured?.apply(this, arguments);
            setTimeout(() => this._h3ReviewApplyLayout?.(), 0);
            return result;
        };
        const graphConfigured = nodeType.prototype.onGraphConfigured;
        nodeType.prototype.onGraphConfigured = function () {
            const result = graphConfigured?.apply(this, arguments);
            setTimeout(() => this._h3ReviewApplyLayout?.(), 0);
            return result;
        };
    },
    async nodeCreated(node) {
        // Official per-instance hook. Keep the prototype hook above for older
        // frontends; mount() is idempotent, so supporting both closes the
        // timing gap without creating two widgets.
        if (nodeType(node) === NODE_NAME) mount(node);
    },
    async afterConfigureGraph() {
        await fetchPending();
        for (const node of allNodes(app.graph)) {
            if (nodeType(node) === NODE_NAME) node._h3RefreshResume?.();
            if (nodeType(node) === NODE_NAME) node._h3ReviewApplyLayout?.();
        }
    },
});
