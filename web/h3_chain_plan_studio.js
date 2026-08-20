import {app} from "/scripts/app.js";
import {api} from "/scripts/api.js";
import {
    H3_CONTEXT_LENGTHS,
    MAX_SHOTS,
    automaticSceneColor,
    calculatePlanTiming,
    duplicateShot,
    formatClock,
    makeShot,
    moveShot,
    parsePlanJson,
    planToJson,
    promptTextToLines,
    promptValueToText,
    randomSceneSeed,
    safeShotId,
    sceneContextLength,
    sceneContinuationMode,
    setSharedPrompt,
    setShotLengthMode,
    sharedPrompt,
    shotLengthMode,
} from "./h3_chain_plan_core.mjs?v=0.4.20";
import {
    promptRevisionLabel,
    promptRevisionNavigation,
} from "./h3_prompt_history_core.mjs?v=0.4.20";
import {availableReferenceRecords} from "./h3_reference_preview_core.mjs?v=0.4.20";
import {
    locateStudioTimelineSecond,
    matchingStudioCheckpoint,
    studioCheckpointSignature,
    studioSceneStartSeconds,
} from "./h3_chain_plan_studio_core.mjs?v=0.4.20";
import * as promptCompanionSync from "./h3_prompt_companion_sync.mjs?v=0.4.20";

const {connectedPromptEditors, publishCompanionScene} = promptCompanionSync;
function publishCompanionPrompt(...args) {
    return promptCompanionSync.publishCompanionPrompt?.(...args) ?? 0;
}

const NODE_NAME = "MiniMaxH3ChainPlanStudio";
const PLAN_NAME = "MiniMaxH3ChainPlan";
const ACTIVE_PROPERTY = "h3_plan_studio_active_scene";
const VIEW_PROPERTY = "h3_plan_studio_view";
const MIN_WIDTH = 820;
const MIN_HEIGHT = 690;

function injectStyles() {
    if (document.getElementById("h3-plan-studio-style")) return;
    const style = document.createElement("style");
    style.id = "h3-plan-studio-style";
    style.textContent = `
        .h3studio {
            --hs-bg:color-mix(in srgb,var(--comfy-menu-bg,#202124) 92%,#101827);
            --hs-panel:color-mix(in srgb,var(--comfy-input-bg,#111827) 84%,#263552);
            --hs-border:color-mix(in srgb,var(--border-color,#555) 68%,#7891bf);
            --hs-text:var(--input-text,#eef1f7); --hs-muted:color-mix(in srgb,var(--hs-text) 57%,transparent);
            --hs-accent:#84aaff; box-sizing:border-box; width:100%; height:100%; min-height:540px;
            display:flex; flex-direction:column; gap:8px; overflow:hidden; padding:10px;
            border:1px solid var(--hs-border); border-radius:8px; background:var(--hs-bg);
            color:var(--hs-text); font:12px/1.35 system-ui,sans-serif;
        }
        .h3studio *, .h3studio *::before, .h3studio *::after { box-sizing:border-box; }
        .h3studio button,.h3studio input,.h3studio select,.h3studio textarea {
            color:var(--hs-text); font:inherit; border:1px solid var(--hs-border);
            border-radius:5px; background:var(--comfy-input-bg,#15171d);
        }
        .h3studio button { padding:5px 8px; cursor:pointer; white-space:nowrap; }
        .h3studio button:hover,.h3studio button.h3studio-active { border-color:var(--hs-accent); }
        .h3studio button.h3studio-active { color:#fff; background:#20375d; }
        .h3studio button:disabled { opacity:.4; cursor:not-allowed; }
        .h3studio input,.h3studio select,.h3studio textarea { width:100%; min-width:0; padding:6px 7px; }
        .h3studio textarea { resize:vertical; line-height:1.5; }
        .h3studio-head,.h3studio-toolbar,.h3studio-statusline,.h3studio-scene-head,
        .h3studio-form,.h3studio-history,.h3studio-json-actions,.h3studio-player-controls {
            display:flex; align-items:center; gap:6px;
        }
        .h3studio-head { justify-content:space-between; }
        .h3studio-title { color:var(--hs-accent); font-size:15px; font-weight:750; }
        .h3studio-run { min-width:0; color:var(--hs-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .h3studio-toolbar { flex-wrap:wrap; }
        .h3studio-spacer { flex:1; }
        .h3studio-statusline { color:var(--hs-muted); flex-wrap:wrap; min-height:18px; }
        .h3studio-statusline strong { color:var(--hs-text); }
        .h3studio-timeline-shell { flex:0 0 auto; padding:7px; border:1px solid var(--hs-border);
            border-radius:7px; background:var(--hs-panel); }
        .h3studio-ruler { position:relative; height:18px; margin-bottom:4px; border-bottom:1px solid var(--hs-border);
            color:var(--hs-muted); font-size:10px; overflow:hidden; cursor:pointer; }
        .h3studio-timeline { display:flex; gap:3px; min-height:76px; overflow-x:auto; overflow-y:hidden; }
        .h3studio-card { --scene:#84aaff; position:relative; isolation:isolate; flex:1 0 138px; min-width:138px;
            height:70px; overflow:hidden; padding:0 !important; text-align:left; border:1px solid var(--scene) !important;
            background:color-mix(in srgb,var(--scene) 13%,var(--comfy-input-bg,#15171d)) !important; }
        .h3studio-card.h3studio-selected { box-shadow:0 0 0 2px var(--scene) inset; }
        .h3studio-card video { position:absolute; inset:0; width:100%; height:100%; object-fit:cover;
            opacity:.58; z-index:-1; background:#08090c; pointer-events:none; }
        .h3studio-card::after { content:""; position:absolute; inset:0; z-index:-1;
            background:linear-gradient(180deg,transparent 10%,rgba(5,7,12,.88)); }
        .h3studio-card-copy { position:absolute; inset:auto 7px 6px; overflow:hidden; }
        .h3studio-card-title { display:block; font-weight:750; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .h3studio-card-meta { display:block; color:#dce5f7; font-size:10px; }
        .h3studio-render-dot { position:absolute; right:6px; top:6px; width:8px; height:8px; border-radius:50%;
            background:#687080; box-shadow:0 0 0 1px #111; }
        .h3studio-rendered .h3studio-render-dot { background:#62d58b; }
        .h3studio-playhead { position:absolute; top:0; bottom:0; width:1px; background:#ff626a; pointer-events:none; }
        .h3studio-panel { flex:1 1 auto; min-height:0; overflow:auto; padding:9px;
            border:1px solid var(--hs-border); border-radius:7px; background:var(--hs-panel); }
        .h3studio-scene-head { margin-bottom:7px; }
        .h3studio-scene-label { color:var(--hs-muted); }
        .h3studio-form { align-items:end; display:grid;
            grid-template-columns:minmax(130px,1.3fr) minmax(175px,1.3fr) minmax(65px,.5fr) minmax(135px,1.1fr) minmax(120px,.85fr) minmax(140px,1fr); margin-bottom:8px; }
        .h3studio-field { display:flex; min-width:0; flex-direction:column; gap:3px; color:var(--hs-muted); }
        .h3studio-length { display:grid; grid-template-columns:112px minmax(80px,1fr); gap:5px; }
        .h3studio-context-pair { display:grid; grid-template-columns:1fr 1fr; gap:5px; }
        .h3studio-prompt { min-height:250px; width:100%; font:15px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace !important; }
        .h3studio-prompt-tools { display:flex; align-items:center; gap:6px; margin:7px 0; flex-wrap:wrap; }
        .h3studio-prompt-delegated { margin-top:10px; padding:12px; border:1px dashed var(--hs-border);
            border-radius:7px; color:var(--hs-muted); background:var(--hs-bg); }
        .h3studio-prompt-delegated strong { display:block; margin-bottom:4px; color:var(--hs-text); }
        .h3studio-hint,.h3studio-message { color:var(--hs-muted); }
        .h3studio-history { justify-content:center; min-height:26px; }
        .h3studio-history-count { min-width:44px; text-align:center; font-variant-numeric:tabular-nums; }
        .h3studio-history-meta { max-width:300px; color:var(--hs-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .h3studio-error { color:#ffb3b3; white-space:pre-wrap; }
        .h3studio-shared { min-height:260px; font:15px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace !important; }
        .h3studio-defaults { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:8px; max-width:390px; }
        .h3studio-json { min-height:360px; font:13px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace !important; }
        .h3studio-json-actions { margin-top:7px; }
        .h3studio-player { display:flex; flex-direction:column; gap:7px; height:100%; min-height:330px; }
        .h3studio-player video { flex:1 1 auto; min-height:260px; width:100%; background:#050608; object-fit:contain; border-radius:6px; }
        .h3studio-player-controls input[type=range] { flex:1; padding:0; }
        .h3studio-refs { display:none; gap:5px; padding:7px; border:1px solid var(--hs-border);
            border-radius:6px; background:var(--hs-bg); flex-wrap:wrap; }
        .h3studio-refs.h3studio-open { display:flex; }
        .h3studio-ref-preview { flex:1 0 100%; display:grid; grid-template-columns:minmax(120px,220px) 1fr;
            gap:8px; align-items:start; color:var(--hs-muted); }
        .h3studio-ref-preview img,.h3studio-ref-preview video { width:100%; max-height:150px; object-fit:contain; background:#08090c; }
        .h3studio-ref-preview audio { width:100%; height:36px; }
        @media(max-width:760px) { .h3studio-form { grid-template-columns:1fr 1fr; }
            .h3studio-defaults { grid-template-columns:1fr; } }
    `;
    document.head.appendChild(style);
}

function element(tag, className = "", text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
}

function button(label, title, action) {
    const item = element("button", "", label);
    item.type = "button";
    item.title = title || "";
    item.addEventListener("click", action);
    return item;
}

function nodeType(node) {
    return node?.comfyClass ?? node?.type ?? null;
}

function allNodes(graph, output = []) {
    for (const node of graph?._nodes ?? []) {
        output.push(node);
        if (node.subgraph) allNodes(node.subgraph, output);
    }
    return output;
}

function upstreamPlanNode(start) {
    const queue = [start];
    const seen = new Set();
    while (queue.length) {
        const node = queue.shift();
        if (!node || seen.has(node)) continue;
        seen.add(node);
        if (node !== start && nodeType(node) === PLAN_NAME) return node;
        for (const input of node.inputs ?? []) {
            if (input.link == null) continue;
            const link = node.graph?.links?.[input.link];
            const parent = link ? node.graph?.getNodeById?.(link.origin_id) : null;
            if (parent) queue.push(parent);
        }
    }
    return null;
}

function widget(node, name) {
    return node?.widgets?.find((item) => item.name === name);
}

function inputSource(node, name) {
    const input = node?.inputs?.find((item) => item.name === name);
    const link = input?.link == null ? null : node.graph?.links?.[input.link];
    return link ? node.graph?.getNodeById?.(link.origin_id) ?? null : null;
}

function mediaExtension(kind) {
    if (kind === "image") return /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i;
    if (kind === "video") return /\.(?:m4v|mkv|mov|mp4|webm)$/i;
    return /\.(?:aac|flac|m4a|mp3|ogg|opus|wav)$/i;
}

function widgetAsset(value, kind) {
    if (value && typeof value === "object" && value.filename) {
        return {filename:String(value.filename), subfolder:String(value.subfolder ?? ""), type:String(value.type ?? "input")};
    }
    let text = typeof value === "string" ? value.trim() : "";
    if (!text) return null;
    if (/^(?:blob:|data:|https?:|\/api\/view\?|\/view\?)/i.test(text)) return {url:text};
    let type = "input";
    const annotated = text.match(/\s+\[(input|output|temp)\]\s*$/i);
    if (annotated) { type = annotated[1].toLowerCase(); text = text.slice(0, annotated.index).trim(); }
    text = text.replaceAll("\\", "/").replace(/^\/+/, "");
    if (!mediaExtension(kind).test(text)) return null;
    const slash = text.lastIndexOf("/");
    return {filename:slash >= 0 ? text.slice(slash + 1) : text,
        subfolder:slash >= 0 ? text.slice(0, slash) : "", type};
}

function assetUrl(asset) {
    if (!asset) return null;
    if (asset.url) return asset.url;
    const query = new URLSearchParams({filename:asset.filename, subfolder:asset.subfolder ?? "", type:asset.type ?? "input"});
    return api.apiURL(`/view?${query.toString()}`);
}

function findMediaPreview(start, kind) {
    const queue = [start];
    const seen = new Set();
    while (queue.length) {
        const current = queue.shift();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        if (kind === "image") {
            const rendered = current.imgs?.[0];
            const src = typeof rendered === "string" ? rendered : rendered?.src;
            if (src) return src;
        }
        for (const item of current.widgets ?? []) {
            const value = widgetAsset(item.value, kind);
            if (value) return assetUrl(value);
        }
        for (const input of current.inputs ?? []) {
            const parent = inputSource(current, input.name);
            if (parent) queue.push(parent);
        }
    }
    return null;
}

function videoUrl(item) {
    if (!item) return "";
    const query = new URLSearchParams({
        filename:item.filename, subfolder:item.subfolder ?? "", type:item.type ?? "output",
    });
    return api.apiURL(`/view?${query.toString()}`);
}

function insertText(textarea, text, selectionOffset = text.length) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    textarea.setRangeText(text, start, end, "end");
    const caret = start + selectionOffset;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event("input", {bubbles:true}));
    textarea.focus();
}

function insertDialogue(textarea) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const selected = textarea.value.slice(start, end);
    const markup = `<d>${selected}</d>`;
    insertText(textarea, markup, selected ? markup.length : 3);
}

function mount(node) {
    if (node._h3PlanStudioMounted || typeof node.addDOMWidget !== "function") return;
    node._h3PlanStudioMounted = true;
    injectStyles();
    node.properties ??= {};

    const root = element("div", "h3studio");
    root.title = "Optional timeline-based editor for the connected H3 Chain Plan.";
    for (const name of ["pointerdown","pointerup","mousedown","mouseup","click","dblclick"]) {
        root.addEventListener(name, (event) => event.stopPropagation());
    }
    root.addEventListener("wheel", (event) => event.stopPropagation());

    const state = {
        plan:null, planNode:null, planWidget:null, lastValue:"", lastRunName:"",
        lastSettingsSignature:"",
        active:Math.max(0, Number(node.properties[ACTIVE_PROPERTY]) || 0),
        view:["scene","shared","player","json"].includes(node.properties[VIEW_PROPERTY])
            ? node.properties[VIEW_PROPERTY] : "scene",
        checkpoints:new Map(), checkpointSignature:"", checkpointError:"", checkpointToken:0,
        pollTimer:null, checkpointTimer:null, timelineHost:null, panelHost:null,
        planNotifyTimer:null,
        playhead:null, player:null, playerAudio:null, playerSlider:null,
        playerIndex:-1,
        timelinePosition:null, pendingSeek:0,
        history:{sceneKey:"", data:null, revisionId:null, host:null, textarea:null,
            status:null, loadToken:0, loadPromise:null, saveTimer:null,
            pendingDraft:null, savePromise:null, error:""},
        promptEditors:[], lastPromptEditorsSignature:"",
    };
    node._h3PlanStudioState = state;

    function dirty() {
        node.graph?.setDirtyCanvas?.(true, true);
        app.graph?.setDirtyCanvas?.(true, true);
    }

    function persistView() {
        node.properties[ACTIVE_PROPERTY] = state.active;
        node.properties[VIEW_PROPERTY] = state.view;
        dirty();
    }

    function runName() {
        return String(widget(state.planNode, "run_name")?.value ?? "").trim();
    }

    function settings() {
        return {
            contextLength:widget(state.planNode, "context_length")?.value ?? 22,
            audioContextLength:widget(state.planNode, "audio_context_length")?.value ?? 22,
            encodeMode:widget(state.planNode, "encode_mode")?.value ?? "video",
            anchorMode:widget(state.planNode, "anchor_mode")?.value ?? "head",
            continuationMode:widget(state.planNode, "continuation_mode")?.value ?? "guide",
            defaultDurationSeconds:widget(state.planNode, "default_duration_seconds")?.value ?? 15,
            defaultSteps:widget(state.planNode, "default_steps")?.value ?? 20,
        };
    }

    function settingsSignature(planNode = state.planNode) {
        return JSON.stringify([
            widget(planNode, "context_length")?.value ?? 22,
            widget(planNode, "audio_context_length")?.value ?? 22,
            widget(planNode, "encode_mode")?.value ?? "video",
            widget(planNode, "anchor_mode")?.value ?? "head",
            widget(planNode, "continuation_mode")?.value ?? "guide",
            widget(planNode, "default_duration_seconds")?.value ?? 15,
            widget(planNode, "default_steps")?.value ?? 20,
        ]);
    }

    function timing() {
        return calculatePlanTiming(state.plan, settings());
    }

    function promptEditorsSignature(editors = state.promptEditors) {
        return editors.map((editor) => `${nodeType(editor)}:${String(editor.id ?? "")}`).sort().join("|");
    }

    function promptEditorLabel() {
        if (state.promptEditors.length > 1) return `${state.promptEditors.length} linked prompt editors`;
        return nodeType(state.promptEditors[0]) === "MiniMaxH3ChainRichScenePromptEditor"
            ? "Rich Scene Prompt Editor" : "Scene Prompt Editor";
    }

    function preserveDelegatedPrompts() {
        if (!state.promptEditors.length || !state.planWidget || !state.plan) return;
        let live;
        try { live = parsePlanJson(String(state.planWidget.value ?? "")); }
        catch (_error) { return; }
        const byId = new Map();
        for (const shot of live.shots) {
            const id = String(shot?.id ?? "").trim();
            if (id && !byId.has(id)) byId.set(id, shot);
        }
        state.plan.shots.forEach((shot, index) => {
            const id = String(shot?.id ?? "").trim();
            const current = (id ? byId.get(id) : null) ?? live.shots[index];
            if (current) shot.prompt = promptTextToLines(promptValueToText(current.prompt));
        });
    }

    function publishActiveScene() {
        if (state.planNode) publishCompanionScene(node, state.planNode, state.active);
    }

    function writePlan(message = null) {
        if (!state.plan || !state.planWidget) return;
        // A linked dedicated editor owns scene prompts. Re-read those fields at
        // the last possible moment so a Studio seed/length edit cannot overwrite
        // prompt text typed since Studio's 500 ms polling snapshot.
        preserveDelegatedPrompts();
        const value = planToJson(state.plan);
        state.lastValue = value;
        state.planWidget.value = value;
        if (state.planNotifyTimer != null) clearTimeout(state.planNotifyTimer);
        const targetWidget = state.planWidget;
        state.planNotifyTimer = setTimeout(() => {
            state.planNotifyTimer = null;
            if (targetWidget !== state.planWidget) return;
            targetWidget.callback?.(targetWidget.value);
        }, 75);
        state.planNode?.graph?.setDirtyCanvas?.(true, true);
        publishCompanionPrompt(
            node, state.planNode, state.active,
            promptValueToText(state.plan.shots[state.active]?.prompt));
        if (message) message.textContent = "Saved to connected Plan";
        renderStatus();
        dirty();
    }

    function historyKey(sceneId) {
        return `${runName()}\u0000${sceneId}`;
    }

    async function historyRequest(query = {}, body = null) {
        const suffix = new URLSearchParams(query).toString();
        const response = await api.fetchApi(
            `/minimax_h3_context_loop/prompt-history${suffix ? `?${suffix}` : ""}`,
            body == null ? undefined : {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)},
        );
        let payload = {};
        try { payload = await response.json(); } catch (_error) {}
        if (!response.ok) throw new Error(payload.error || `Prompt history request failed (HTTP ${response.status}).`);
        return payload;
    }

    function renderHistory() {
        const history = state.history;
        if (!history.host) return;
        history.host.replaceChildren();
        if (history.error) {
            history.host.append(element("span", "h3studio-history-meta h3studio-error", history.error));
            return;
        }
        if (!history.data) {
            history.host.append(element("span", "h3studio-history-meta", "Loading prompt versions…"));
            return;
        }
        const navigation = promptRevisionNavigation(history.data, history.revisionId);
        const previous = button("‹", "Previous prompt version", () => {
            if (navigation.previous) void selectHistoryRevision(navigation.previous.id);
        });
        const next = button("›", "Next prompt version", () => {
            if (navigation.next) void selectHistoryRevision(navigation.next.id);
        });
        previous.disabled = !navigation.previous;
        next.disabled = !navigation.next;
        const count = element("span", "h3studio-history-count", `${navigation.position} / ${navigation.total}`);
        const metadata = element("span", "h3studio-history-meta", promptRevisionLabel(navigation));
        metadata.title = metadata.textContent;
        history.host.append(previous, count, next, metadata);
    }

    async function loadHistory(sceneId, prompt, synchronize = true) {
        const history = state.history;
        const currentRun = runName();
        const key = historyKey(sceneId);
        const token = ++history.loadToken;
        history.sceneKey = key; history.data = null; history.revisionId = null; history.error = "";
        renderHistory();
        if (!currentRun) { history.error = "Set a Plan run_name to enable prompt history."; renderHistory(); return; }
        const request = synchronize ? historyRequest({}, {
            action:"save", run_name:currentRun, scene_id:sceneId, prompt, parent_revision:null,
        }) : historyRequest({run_name:currentRun, scene_id:sceneId});
        history.loadPromise = request;
        try {
            const payload = await request;
            if (token !== history.loadToken || history.sceneKey !== key) return;
            history.data = payload.history ?? payload;
            history.revisionId = payload.revision?.id ?? history.data.active_revision ?? null;
        } catch (error) {
            if (token === history.loadToken && history.sceneKey === key) history.error = error?.message || String(error);
        } finally {
            if (history.loadPromise === request) history.loadPromise = null;
            if (token === history.loadToken && history.sceneKey === key) renderHistory();
        }
    }

    function scheduleHistoryDraft(sceneId, prompt) {
        const currentRun = runName();
        if (!currentRun) return;
        const history = state.history;
        history.pendingDraft = {key:historyKey(sceneId), runName:currentRun, sceneId, prompt};
        if (history.saveTimer != null) clearTimeout(history.saveTimer);
        history.saveTimer = setTimeout(() => { history.saveTimer = null; void flushHistoryDraft(); }, 650);
    }

    async function flushHistoryDraft() {
        const history = state.history;
        if (history.saveTimer != null) { clearTimeout(history.saveTimer); history.saveTimer = null; }
        if (history.savePromise) { await history.savePromise; return history.pendingDraft ? flushHistoryDraft() : undefined; }
        const draft = history.pendingDraft;
        if (!draft) return;
        history.pendingDraft = null;
        if (history.loadPromise && history.sceneKey === draft.key) await history.loadPromise;
        const request = historyRequest({}, {action:"save", run_name:draft.runName,
            scene_id:draft.sceneId, prompt:draft.prompt,
            parent_revision:history.sceneKey === draft.key ? history.revisionId : null});
        history.savePromise = request;
        try {
            const payload = await request;
            if (history.sceneKey === draft.key) {
                history.data = payload.history; history.revisionId = payload.revision?.id ?? payload.history?.active_revision;
                history.error = ""; renderHistory();
            }
        } catch (error) {
            if (history.sceneKey === draft.key) { history.error = error?.message || String(error); renderHistory(); }
        } finally { if (history.savePromise === request) history.savePromise = null; }
        if (history.pendingDraft) await flushHistoryDraft();
    }

    async function selectHistoryRevision(revisionId) {
        await flushHistoryDraft();
        const shot = state.plan?.shots?.[state.active];
        const history = state.history;
        if (!shot || !history.textarea) return;
        const sceneId = safeShotId(shot.id, `clip_${String(state.active + 1).padStart(4,"0")}`);
        const key = historyKey(sceneId);
        try {
            const payload = await historyRequest({}, {action:"activate", run_name:runName(), scene_id:sceneId, revision:revisionId});
            if (history.sceneKey !== key) return;
            history.data = payload.history; history.revisionId = payload.revision.id; history.error = "";
            history.textarea.value = String(payload.revision.prompt ?? "");
            shot.prompt = promptTextToLines(history.textarea.value);
            writePlan(history.status); renderHistory(); history.textarea.focus();
        } catch (error) { if (history.sceneKey === key) { history.error = error?.message || String(error); renderHistory(); } }
    }

    async function refreshCheckpoints() {
        const currentRun = runName();
        const token = ++state.checkpointToken;
        if (!currentRun) {
            const changed = state.checkpoints.size > 0
                || Boolean(state.checkpointSignature) || Boolean(state.checkpointError);
            state.checkpoints = new Map(); state.checkpointSignature = "";
            state.checkpointError = "";
            if (changed) { renderTimeline(); renderStatus(); }
            return;
        }
        try {
            const query = new URLSearchParams({run_name:currentRun});
            const response = await api.fetchApi(`/minimax_h3_context_loop/checkpoints?${query.toString()}`);
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
            if (token !== state.checkpointToken || currentRun !== runName()) return;
            const records = payload.checkpoints ?? [];
            const signature = studioCheckpointSignature(currentRun, records);
            const recoveredFromError = Boolean(state.checkpointError);
            state.checkpointError = "";
            if (signature === state.checkpointSignature) {
                if (recoveredFromError) renderStatus();
                return;
            }
            state.checkpointSignature = signature;
            state.checkpoints = new Map(records.map((item) => [Number(item.scene), item]));
        } catch (error) {
            if (token !== state.checkpointToken) return;
            state.checkpointError = error?.message || String(error);
            renderStatus();
            return;
        }
        renderTimeline(); renderStatus();
        if (state.view === "player" && state.player?.paused) {
            const media = playerCheckpoint(state.playerIndex);
            const desired = media?.video ? videoUrl(media.video) : "";
            const desiredAudio = media?.audio ? videoUrl(media.audio) : "";
            if (desired !== String(state.player.dataset.source ?? "") ||
                    desiredAudio !== String(
                        state.playerAudio?.dataset.source ?? "")) renderPanel();
        }
    }

    function renderStatus() {
        const host = root.querySelector(".h3studio-statusline");
        if (!host || !state.plan) return;
        const result = timing();
        const ready = result.shots.filter(
            (row, index) => matchingStudioCheckpoint(state.checkpoints, index, row),
        ).length;
        host.replaceChildren();
        host.append(
            element("strong", "", `${result.shots.length} scenes`),
            document.createTextNode(`${result.totalFrames} delivered frames · ${formatClock(result.totalSeconds)}`),
            document.createTextNode(`${settings().contextLength}f overlap · ${ready}/${result.shots.length} rendered`),
        );
        if (result.errors.length) host.append(element("span", "h3studio-error", `${result.errors.length} plan issue${result.errors.length === 1 ? "" : "s"}`));
        if (state.checkpointError) host.append(element("span", "h3studio-error", state.checkpointError));
    }

    function renderRuler(ruler, totalSeconds) {
        ruler.replaceChildren();
        const intervals = totalSeconds > 90 ? 30 : totalSeconds > 35 ? 10 : 5;
        for (let second = 0; second <= totalSeconds + .001; second += intervals) {
            const label = element("span", "", formatClock(second));
            label.style.position = "absolute";
            label.style.left = `${totalSeconds ? second / totalSeconds * 100 : 0}%`;
            label.style.transform = second ? "translateX(-50%)" : "";
            ruler.append(label);
        }
        const playhead = element("span", "h3studio-playhead");
        playhead.style.left = "0%";
        ruler.append(playhead);
        state.playhead = playhead;
        ruler.addEventListener("click", (event) => {
            if (!totalSeconds) return;
            const rect = ruler.getBoundingClientRect();
            const target = Math.max(0, Math.min(totalSeconds, (event.clientX - rect.left) / rect.width * totalSeconds));
            state.timelinePosition = target;
            state.view = "player"; persistView(); renderToolbarState(); renderPanel();
        });
    }

    function renderTimeline() {
        const host = state.timelineHost;
        if (!host || !state.plan) return;
        host.replaceChildren();
        const result = timing();
        for (let index = 0; index < state.plan.shots.length; index += 1) {
            const shot = state.plan.shots[index];
            const row = result.shots[index];
            const checkpoint = matchingStudioCheckpoint(state.checkpoints, index, row);
            const card = button("", `Scene ${index + 1}: ${row.id}`, () => void selectScene(index));
            card.className = `h3studio-card${index === state.active ? " h3studio-selected" : ""}${checkpoint?.ready ? " h3studio-rendered" : ""}`;
            card.style.setProperty("--scene", automaticSceneColor(index));
            card.style.flexGrow = String(Math.max(.55, row.deliveredFrames / Math.max(1, result.totalFrames) * state.plan.shots.length));
            const preview = checkpoint?.preview_video ?? checkpoint?.video;
            if (preview) {
                const media = element("video");
                media.muted = true; media.playsInline = true; media.preload = "metadata"; media.src = videoUrl(preview);
                media.addEventListener("loadedmetadata", () => {
                    if (Number.isFinite(media.duration) && media.duration > .1) {
                        try { media.currentTime = Math.min(.15, media.duration / 2); }
                        catch (_error) {}
                    }
                }, {once:true});
                card.append(media);
            }
            const copy = element("span", "h3studio-card-copy");
            copy.append(element("span", "h3studio-card-title", `${index + 1}. ${row.id}`),
                element("span", "h3studio-card-meta", `${formatClock(row.deliveredSeconds)} · ${row.rawFrames || "—"}f raw`));
            card.append(copy, element("span", "h3studio-render-dot"));
            host.append(card);
        }
    }

    function updateTimelineSelection() {
        if (!state.timelineHost) return;
        [...state.timelineHost.querySelectorAll(".h3studio-card")].forEach(
            (card, index) => card.classList.toggle("h3studio-selected", index === state.active),
        );
    }

    async function selectScene(index, synchronize = true) {
        await flushHistoryDraft();
        state.active = Math.max(0, Math.min(state.plan.shots.length - 1, Number(index)));
        if (state.view === "player") {
            state.timelinePosition = studioSceneStartSeconds(timing().shots, state.active);
        }
        persistView(); updateTimelineSelection(); renderPanel();
        if (synchronize) publishActiveScene();
    }

    function field(label, control) {
        const wrap = element("label", "h3studio-field");
        wrap.append(element("span", "", label), control);
        return wrap;
    }

    function renderReferenceTray(tray, textarea) {
        tray.replaceChildren();
        const referenceData = availableReferenceRecords(
            state.planNode ?? node, state.active + 1, {
                includeInactive: true,
                prompt: [
                    sharedPrompt(state.plan).text.trim(), textarea.value.trim(),
                ].filter(Boolean).join("\n\n"),
            },
        );
        const {wrapper} = referenceData;
        const records = referenceData.mode === "tagged"
            ? referenceData.records
            : referenceData.records.filter((record) => record.active);
        if (!records.length) {
            tray.append(element("span", "h3studio-message", wrapper
                ? `No connected references are active in scene ${state.active + 1}.`
                : "No downstream Tagged/Scheduled Ref2VA, core Ref2VA, or I2V references were found."));
            return;
        }
        const preview = element("div", "h3studio-ref-preview");
        function show(record) {
            preview.replaceChildren();
            const kind = record.kind === "picture" ? "image" : record.kind;
            const url = findMediaPreview(record.source, kind);
            if (url) {
                const media = element(kind === "image" ? "img" : kind);
                media.src = url;
                if (kind !== "image") { media.controls = true; media.preload = "metadata"; }
                preview.append(media);
            }
            preview.append(element("div", "", `${record.token}${record.label && record.label !== record.token ? ` → ${record.label}` : ""}\n${record.kind} · ${record.selector === "prompt tag" ? "insert to activate" : `scenes ${record.selector}`}`));
        }
        const icons = {picture:"▧",video:"▶",audio:"♫"};
        for (const record of records) {
            const chip = button(`${icons[record.kind] ?? "@"} ${record.token}`, "Insert this connected reference label or alias", () => {
                insertText(textarea, record.token); tray.classList.remove("h3studio-open");
            });
            chip.addEventListener("mouseenter", () => show(record));
            chip.addEventListener("focus", () => show(record));
            tray.append(chip);
        }
        tray.append(preview); show(records[0]);
    }

    function renderScenePanel() {
        const shot = state.plan.shots[state.active];
        const row = timing().shots[state.active];
        const panel = element("div");
        const head = element("div", "h3studio-scene-head");
        head.append(element("strong", "", `Scene ${state.active + 1} of ${state.plan.shots.length}`),
            element("span", "h3studio-scene-label", `${row.rawFrames || "—"} raw · ${row.deliveredFrames || "—"} delivered · starts at ${formatClock(row.generationStartFrame / 24)}`));

        const id = element("input");
        id.value = shot.id ?? "";
        id.addEventListener("change", () => {
            shot.id = safeShotId(id.value, row.id); id.value = shot.id;
            writePlan(); renderShell();
        });
        const mode = element("select");
        for (const [value,label] of [["default","Plan default"],["seconds","Seconds"],["frames","Exact frames"]]) {
            const option = element("option", "", label); option.value = value; mode.append(option);
        }
        const length = element("input"); length.type = "number";
        function refreshLength() {
            const selected = shotLengthMode(shot); mode.value = selected; length.disabled = selected === "default";
            if (selected === "seconds") { length.value = shot.duration_seconds ?? ""; length.min = ".01"; length.max = String(3592 / 24); length.step = ".01"; }
            else if (selected === "frames") { length.value = shot.length ?? shot.frames ?? ""; length.min = "5"; length.max = "3592"; length.step = "17"; }
            else length.value = "";
        }
        mode.addEventListener("change", () => {
            setShotLengthMode(shot, mode.value, state.plan.defaults?.duration_seconds ?? settings().defaultDurationSeconds);
            refreshLength(); writePlan(); renderShell();
        });
        length.addEventListener("change", () => {
            if (mode.value === "seconds") shot.duration_seconds = Number(length.value);
            if (mode.value === "frames") { shot.length = Number(length.value); delete shot.frames; }
            writePlan(); renderShell();
        });
        refreshLength();
        const lengthControl = element("span", "h3studio-length"); lengthControl.append(mode, length);
        const steps = element("input"); steps.type = "number"; steps.min = "1"; steps.max = "10000";
        steps.placeholder = String(state.plan.defaults?.steps ?? settings().defaultSteps); steps.value = shot.steps ?? "";
        steps.addEventListener("change", () => { if (steps.value) shot.steps = Number(steps.value); else delete shot.steps; writePlan(); });
        const seed = element("input"); seed.type = "text"; seed.inputMode = "numeric"; seed.placeholder = "Stable derived seed"; seed.value = shot.seed ?? "";
        seed.addEventListener("change", () => { if (seed.value.trim()) shot.seed = seed.value.trim(); else delete shot.seed; writePlan(); });
        const seedWrap = element("span", "h3studio-length");
        const reroll = button("↻", "Store a new random seed for this scene", () => { seed.value = randomSceneSeed(); shot.seed = seed.value; writePlan(); });
        seedWrap.append(seed, reroll);
        const context = element("select");
        for (const [value, label] of [
            ["", `Plan default · ${settings().contextLength}`],
            ["0", "0 · new visual"],
            ...H3_CONTEXT_LENGTHS.map((value) => [String(value), `${value} frames`]),
        ]) {
            const option = element("option", "", label);
            option.value = value;
            context.append(option);
        }
        context.value = Object.hasOwn(shot, "context_length")
            && shot.context_length !== null ? String(shot.context_length) : "";
        context.title = state.active === 0
            ? "Blank inherits the Plan video context. Zero ignores Existing Video Context visually."
            : "Video context entering this scene. Blank inherits the Plan default; zero starts a visually new scene. Audio is controlled beside it.";
        context.addEventListener("change", () => {
            if (context.value === "") delete shot.context_length;
            else shot.context_length = Number(context.value);
            sceneContextLength(shot, settings().contextLength);
            writePlan();
            renderStatus();
        });
        const audioContext = element("input");
        audioContext.type = "number";
        audioContext.min = "0";
        audioContext.max = "240";
        audioContext.step = "1";
        audioContext.value = shot.audio_context_length ?? "";
        const planAudioContextLength = Number(settings().audioContextLength);
        audioContext.placeholder = planAudioContextLength
            ? String(planAudioContextLength)
            : `Video ${settings().contextLength}`;
        audioContext.title = "Blank inherits the Plan audio context; an explicit 0 carries no prior generated audio. Positive audio context works with zero video context in guide generated-audio modes. Masked AV remains synchronized to video.";
        audioContext.addEventListener("change", () => {
            if (audioContext.value === "") delete shot.audio_context_length;
            else shot.audio_context_length = Number(audioContext.value);
            writePlan();
            renderStatus();
        });
        const contextPair = element("span", "h3studio-context-pair");
        contextPair.append(context, audioContext);
        const continuation = element("select");
        for (const [value, label] of [
            ["", `Plan default · ${settings().continuationMode}`],
            ["guide", "Guide · new shot"],
            ["latent_guide", "Latent Guide · raw latent"],
            ["masked_av", "Masked AV · same shot"],
        ]) {
            const option = element("option", "", label);
            option.value = value;
            continuation.append(option);
        }
        continuation.value = Object.hasOwn(shot, "continuation_mode")
            ? shot.continuation_mode : "";
        continuation.title = state.active === 0
            ? "Continuation into this scene. Scene 1 uses it only with Existing Video Context."
            : "Guide uses VAE-encoded frames; Latent Guide uses the native sampled latent; Masked AV preserves an exact prefix for continuing the same shot.";
        continuation.addEventListener("change", () => {
            if (continuation.value) shot.continuation_mode = continuation.value;
            else delete shot.continuation_mode;
            sceneContinuationMode(shot, settings().continuationMode);
            writePlan();
            renderStatus();
        });
        const form = element("div", "h3studio-form");
        form.append(
            field("Scene ID", id), field("Length", lengthControl),
            field("Steps", steps), field("Seed", seedWrap),
            field("Context V / A", contextPair),
            field("Continuation", continuation),
        );

        if (state.promptEditors.length) {
            const delegated = element("div", "h3studio-prompt-delegated");
            delegated.append(
                element("strong", "", `Prompt editing delegated to ${promptEditorLabel()}`),
                document.createTextNode(
                    "Use the linked editor for prompt text and revision history. " +
                    "Scene selection is synchronized in both directions; Studio keeps scene ID, length, steps, seed, timeline, and playback controls.",
                ),
            );
            panel.append(head, form, delegated);
            return panel;
        }

        const prompt = element("textarea", "h3studio-prompt");
        prompt.value = promptValueToText(shot.prompt, `Scene ${state.active + 1} prompt`);
        prompt.placeholder = "Write this scene's action, camera, performance, dialogue, sound, and ending continuity…";
        prompt.spellcheck = true;
        const message = element("span", "h3studio-message", "Synchronized with Plan");
        prompt.addEventListener("input", () => {
            shot.prompt = promptTextToLines(prompt.value); writePlan(message);
            scheduleHistoryDraft(row.id, prompt.value);
        });
        prompt.addEventListener("keydown", (event) => {
            if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); void selectScene(state.active - 1); }
            else if (event.altKey && event.key === "ArrowRight") { event.preventDefault(); void selectScene(state.active + 1); }
            else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === "#") { event.preventDefault(); insertDialogue(prompt); }
        });
        const tools = element("div", "h3studio-prompt-tools");
        const tray = element("div", "h3studio-refs");
        tools.append(
            button("@ Reference", "Show connected reference tags and previews", () => {
                const opening = !tray.classList.contains("h3studio-open");
                if (opening) renderReferenceTray(tray, prompt); tray.classList.toggle("h3studio-open", opening);
            }),
            button("# Dialogue", "Wrap the selected text in <d> dialogue tags", () => insertDialogue(prompt)),
            element("span", "h3studio-hint", "Alt+←/→ scenes"), message,
        );
        const history = element("div", "h3studio-history");
        state.history.host = history; state.history.textarea = prompt; state.history.status = message;
        panel.append(head, form, prompt, tools, tray, history);
        void loadHistory(row.id, prompt.value);
        return panel;
    }

    function renderSharedPanel() {
        const panel = element("div");
        panel.append(element("div", "h3studio-scene-head", "Shared prompt — prepended to every scene"));
        const textarea = element("textarea", "h3studio-shared");
        textarea.value = sharedPrompt(state.plan).text;
        textarea.placeholder = "Identity, wardrobe, style, reference definitions, audio rules, and global continuity…";
        textarea.addEventListener("input", () => { setSharedPrompt(state.plan, textarea.value); writePlan(); });
        state.plan.defaults = state.plan.defaults && typeof state.plan.defaults === "object" && !Array.isArray(state.plan.defaults)
            ? state.plan.defaults : {};
        const duration = element("input"); duration.type = "number"; duration.step = ".01";
        duration.placeholder = String(settings().defaultDurationSeconds); duration.value = state.plan.defaults.duration_seconds ?? "";
        duration.addEventListener("change", () => { if (duration.value) state.plan.defaults.duration_seconds = Number(duration.value); else delete state.plan.defaults.duration_seconds; writePlan(); renderShell(); });
        const steps = element("input"); steps.type = "number"; steps.min = "1"; steps.max = "10000";
        steps.placeholder = String(settings().defaultSteps); steps.value = state.plan.defaults.steps ?? "";
        steps.addEventListener("change", () => { if (steps.value) state.plan.defaults.steps = Number(steps.value); else delete state.plan.defaults.steps; writePlan(); });
        const defaults = element("div", "h3studio-defaults");
        defaults.append(field("Default seconds (blank = Plan widget)", duration), field("Default steps (blank = Plan widget)", steps));
        panel.append(textarea, defaults);
        return panel;
    }

    function playerCheckpoint(index) {
        const item = matchingStudioCheckpoint(
            state.checkpoints, index, timing().shots[index],
        );
        if (!item) return null;
        return {
            video:item.preview_video ?? item.video,
            // Review previews already contain synchronized audio. Raw saved
            // segments do not, so pair those with their delivered WAV.
            audio:item.preview_video ? null : (item.audio ?? null),
        };
    }

    function disposePlayer() {
        const current = state.player;
        const currentAudio = state.playerAudio;
        state.player = null;
        state.playerAudio = null;
        state.playerSlider = null;
        for (const media of [current, currentAudio]) {
            if (!media) continue;
            try { media.pause(); } catch (_error) {}
            media.removeAttribute("src");
            delete media.dataset.source;
            try { media.load(); } catch (_error) {}
        }
    }

    function seekTimeline(seconds, autoplay = false) {
        const result = timing();
        const location = locateStudioTimelineSecond(result.shots, seconds);
        if (location.index < 0) return;
        const {index, localSeconds, targetSeconds:target} = location;
        const media = playerCheckpoint(index);
        const source = media?.video;
        state.playerIndex = index; state.pendingSeek = localSeconds;
        state.timelinePosition = target;
        if (state.active !== index) {
            state.active = index; persistView(); updateTimelineSelection();
            publishActiveScene();
        }
        if (state.playerSlider) state.playerSlider.value = String(target);
        if (state.playhead) state.playhead.style.left = `${result.totalSeconds ? target / result.totalSeconds * 100 : 0}%`;
        if (!state.player) return;
        if (!source) {
            delete state.player.dataset.source;
            state.player.removeAttribute("src"); state.player.load();
            if (state.playerAudio) {
                try { state.playerAudio.pause(); } catch (_error) {}
                delete state.playerAudio.dataset.source;
                state.playerAudio.removeAttribute("src");
                state.playerAudio.load();
            }
            const label = root.querySelector(".h3studio-player-label");
            if (label) label.textContent = `Scene ${index + 1} has no saved segment.`;
            return;
        }
        const url = videoUrl(source);
        const targetPlayer = state.player;
        const targetAudio = state.playerAudio;
        const requestedSeek = state.pendingSeek;
        const audioUrl = media?.audio ? videoUrl(media.audio) : "";
        if (targetAudio && targetAudio.dataset.source !== audioUrl) {
            try { targetAudio.pause(); } catch (_error) {}
            if (audioUrl) {
                targetAudio.dataset.source = audioUrl;
                targetAudio.src = audioUrl;
            } else {
                delete targetAudio.dataset.source;
                targetAudio.removeAttribute("src");
            }
            targetAudio.load();
        }
        const seekAudio = () => {
            if (!targetAudio?.dataset.source) return;
            const duration = Number.isFinite(targetAudio.duration)
                ? targetAudio.duration : requestedSeek;
            try { targetAudio.currentTime = Math.min(
                requestedSeek, Math.max(0, duration - .02),
            ); } catch (_error) {}
        };
        const applySeek = () => {
            if (state.player !== targetPlayer || !targetPlayer?.isConnected) return;
            const duration = Number.isFinite(targetPlayer.duration) ? targetPlayer.duration : requestedSeek;
            try { targetPlayer.currentTime = Math.min(requestedSeek, Math.max(0, duration - .02)); }
            catch (_error) {}
            seekAudio();
            if (autoplay) void targetPlayer.play().catch(() => {});
        };
        if (targetAudio?.dataset.source) {
            targetAudio.addEventListener("loadedmetadata", seekAudio, {once:true});
        }
        if (targetPlayer.dataset.source !== url) {
            targetPlayer.dataset.source = url; targetPlayer.src = url; targetPlayer.load();
            targetPlayer.addEventListener("loadedmetadata", applySeek, {once:true});
        } else applySeek();
        const label = root.querySelector(".h3studio-player-label");
        if (label) label.textContent = `Scene ${index + 1} · ${timing().shots[index].id}`;
    }

    function renderPlayerPanel() {
        const wrapper = element("div", "h3studio-player");
        const label = element("div", "h3studio-player-label", "Saved scene preview");
        const video = element("video"); video.controls = true; video.playsInline = true; video.preload = "metadata";
        const audio = element("audio"); audio.preload = "metadata"; audio.hidden = true;
        const controls = element("div", "h3studio-player-controls");
        const play = button("▶", "Play the delivered timeline from the current position", () => {
            void video.play().catch(() => {});
        });
        const slider = element("input"); slider.type = "range"; slider.min = "0"; slider.max = String(timing().totalSeconds); slider.step = String(1 / 24); slider.value = "0";
        const clock = element("span", "", `0 / ${formatClock(timing().totalSeconds)}`);
        slider.addEventListener("input", () => seekTimeline(Number(slider.value), false));
        const synchronizeAudio = (play = false) => {
            if (!audio.dataset.source) return;
            audio.playbackRate = video.playbackRate;
            if (Math.abs((Number(audio.currentTime) || 0) -
                    (Number(video.currentTime) || 0)) > .12) {
                try { audio.currentTime = video.currentTime; } catch (_error) {}
            }
            if (play) void audio.play().catch(() => {});
        };
        video.addEventListener("playing", () => synchronizeAudio(true));
        video.addEventListener("pause", () => audio.pause());
        video.addEventListener("waiting", () => audio.pause());
        video.addEventListener("seeking", () => {
            audio.pause(); synchronizeAudio(false);
        });
        video.addEventListener("seeked", () => {
            synchronizeAudio(!video.paused);
        });
        video.addEventListener("ratechange", () => synchronizeAudio(false));
        video.addEventListener("timeupdate", () => {
            synchronizeAudio(false);
            const result = timing();
            let prior = 0;
            for (let index = 0; index < state.playerIndex; index += 1) prior += result.shots[index].deliveredSeconds;
            const current = Math.min(result.totalSeconds, prior + video.currentTime);
            state.timelinePosition = current;
            slider.value = String(current); clock.textContent = `${formatClock(current)} / ${formatClock(result.totalSeconds)}`;
            if (state.playhead) state.playhead.style.left = `${result.totalSeconds ? current / result.totalSeconds * 100 : 0}%`;
        });
        video.addEventListener("ended", () => {
            audio.pause();
            const next = state.playerIndex + 1;
            if (next >= state.plan.shots.length) return;
            const result = timing();
            const start = studioSceneStartSeconds(result.shots, next);
            seekTimeline(start, true);
        });
        state.player = video; state.playerAudio = audio;
        state.playerSlider = slider;
        controls.append(play, slider, clock, button("Refresh", "Rescan saved checkpoints and segments", async () => {
            await refreshCheckpoints(); renderPanel();
        }));
        wrapper.append(label, video, audio, controls,
            element("div", "h3studio-message", "Playback uses synchronized Review previews when available and otherwise pairs each saved segment with its delivered-audio sidecar."));
        setTimeout(() => {
            if (state.player !== video || !video.isConnected) return;
            const result = timing();
            const start = state.timelinePosition == null
                ? studioSceneStartSeconds(result.shots, state.active)
                : state.timelinePosition;
            seekTimeline(start, false);
        }, 0);
        return wrapper;
    }

    function renderJsonPanel() {
        const panel = element("div");
        const textarea = element("textarea", "h3studio-json"); textarea.value = planToJson(state.plan); textarea.spellcheck = false;
        const status = element("span", "h3studio-message", "Raw JSON escape hatch");
        const actions = element("div", "h3studio-json-actions");
        actions.append(button("Apply JSON", "Validate and replace the current plan JSON", () => {
            try { state.plan = parsePlanJson(textarea.value); state.active = Math.min(state.active, state.plan.shots.length - 1); writePlan(); status.textContent = "JSON applied"; renderShell(); publishActiveScene(); }
            catch (error) { status.textContent = error.message; status.classList.add("h3studio-error"); }
        }), button("Copy", "Copy plan JSON", async () => {
            try { await navigator.clipboard.writeText(textarea.value); status.textContent = "Copied"; }
            catch (_error) { textarea.select(); document.execCommand("copy"); status.textContent = "Copied"; }
        }), status);
        panel.append(textarea, actions); return panel;
    }

    function renderPanel() {
        if (!state.panelHost || !state.plan) return;
        state.history.host = null; state.history.textarea = null; state.history.status = null;
        disposePlayer();
        const content = state.view === "shared" ? renderSharedPanel()
            : state.view === "player" ? renderPlayerPanel()
              : state.view === "json" ? renderJsonPanel() : renderScenePanel();
        state.panelHost.replaceChildren(content);
    }

    function renderToolbarState() {
        for (const item of root.querySelectorAll("[data-studio-view]")) {
            item.classList.toggle("h3studio-active", item.dataset.studioView === state.view);
        }
    }

    function renderShell() {
        disposePlayer();
        root.replaceChildren();
        const head = element("div", "h3studio-head");
        head.append(element("span", "h3studio-title", "MiniMax H3 Plan Studio"),
            element("span", "h3studio-run", runName() ? `run · ${runName()}` : "connect a named Plan"));
        const toolbar = element("div", "h3studio-toolbar");
        const add = button("+ Scene", "Append a new scene and select it", async () => {
            if (state.plan.shots.length >= MAX_SHOTS) return;
            await flushHistoryDraft();
            state.plan.shots.push(makeShot(state.plan.shots));
            state.active = state.plan.shots.length - 1;
            state.timelinePosition = null; persistView(); writePlan(); renderShell(); publishActiveScene();
        });
        add.disabled = state.plan.shots.length >= MAX_SHOTS;
        const duplicate = button("Duplicate", "Duplicate the selected scene", async () => {
            if (state.plan.shots.length >= MAX_SHOTS) return;
            await flushHistoryDraft();
            duplicateShot(state.plan.shots, state.active); state.active += 1;
            state.timelinePosition = null; persistView(); writePlan(); renderShell(); publishActiveScene();
        });
        const remove = button("Delete", "Delete the selected scene", async () => {
            if (state.plan.shots.length <= 1 || !confirm(`Delete scene ${state.active + 1}?`)) return;
            await flushHistoryDraft();
            state.plan.shots.splice(state.active, 1);
            state.active = Math.min(state.active, state.plan.shots.length - 1);
            state.timelinePosition = null; persistView(); writePlan(); renderShell(); publishActiveScene();
        });
        remove.disabled = state.plan.shots.length <= 1;
        const left = button("←", "Move selected scene earlier", async () => {
            if (!state.active) return; await flushHistoryDraft();
            moveShot(state.plan.shots, state.active, state.active - 1); state.active -= 1;
            state.timelinePosition = null; persistView(); writePlan(); renderShell(); publishActiveScene();
        }); left.disabled = !state.active;
        const right = button("→", "Move selected scene later", async () => {
            if (state.active >= state.plan.shots.length - 1) return; await flushHistoryDraft();
            moveShot(state.plan.shots, state.active, state.active + 1); state.active += 1;
            state.timelinePosition = null; persistView(); writePlan(); renderShell(); publishActiveScene();
        }); right.disabled = state.active >= state.plan.shots.length - 1;
        toolbar.append(add, duplicate, remove, left, right, element("span", "h3studio-spacer"));
        const sceneViewLabel = state.promptEditors.length ? "Scene settings" : "Scene prompt";
        for (const [value,label] of [["scene",sceneViewLabel],["shared","Shared prompt"],["player","Player"],["json","JSON"]]) {
            const item = button(label, `Open ${label.toLowerCase()} view`, () => {
                void flushHistoryDraft();
                if (value === "player" && state.timelinePosition == null) {
                    state.timelinePosition = studioSceneStartSeconds(timing().shots, state.active);
                }
                state.view = value; persistView(); renderToolbarState(); renderPanel();
            });
            item.dataset.studioView = value; toolbar.append(item);
        }
        const status = element("div", "h3studio-statusline");
        const shell = element("div", "h3studio-timeline-shell");
        const ruler = element("div", "h3studio-ruler");
        const timelineHost = element("div", "h3studio-timeline");
        shell.append(ruler, timelineHost); state.timelineHost = timelineHost;
        const panelHost = element("div", "h3studio-panel"); state.panelHost = panelHost;
        root.append(head, toolbar, status, shell, panelHost);
        renderRuler(ruler, timing().totalSeconds); renderToolbarState(); renderStatus(); renderTimeline(); renderPanel();
    }

    function showFailure(message) {
        disposePlayer();
        root.replaceChildren(element("div", "h3studio-title", "MiniMax H3 Plan Studio"),
            element("div", "h3studio-error", message),
            element("div", "h3studio-message", "Connect the original H3 Chain Plan output to this node's plan input."));
    }

    function loadPlan(force = false) {
        const planNode = upstreamPlanNode(node);
        const planWidget = widget(planNode, "plan_json");
        if (!planNode || !planWidget) {
            if (force || state.planNode) { state.plan = null; state.planNode = null; state.planWidget = null; showFailure("No connected H3 Chain Plan was found."); }
            return;
        }
        const value = String(planWidget.value ?? "");
        const currentRun = String(widget(planNode, "run_name")?.value ?? "").trim();
        const currentSettings = settingsSignature(planNode);
        const promptEditors = connectedPromptEditors(node).filter(
            (editor) => upstreamPlanNode(editor) === planNode,
        );
        const currentPromptEditors = promptEditorsSignature(promptEditors);
        if (!force && planNode === state.planNode && value === state.lastValue
                && currentRun === state.lastRunName
                && currentSettings === state.lastSettingsSignature
                && currentPromptEditors === state.lastPromptEditorsSignature) return;
        try {
            const runChanged = planNode !== state.planNode || currentRun !== state.lastRunName;
            state.plan = parsePlanJson(value); state.planNode = planNode; state.planWidget = planWidget;
            state.lastValue = value; state.lastRunName = currentRun;
            state.lastSettingsSignature = currentSettings;
            state.promptEditors = promptEditors;
            state.lastPromptEditorsSignature = currentPromptEditors;
            if (runChanged) {
                state.checkpoints = new Map(); state.checkpointSignature = "";
                state.checkpointError = ""; state.timelinePosition = null;
            }
            state.active = Math.min(state.active, state.plan.shots.length - 1); renderShell(); void refreshCheckpoints();
        } catch (error) { showFailure(`Connected Plan JSON is invalid:\n${error.message}`); }
    }

    const domWidget = node.addDOMWidget("h3_plan_studio", "h3-plan-studio", root, {
        serialize:false, hideOnZoom:false, getMinHeight:() => 540,
    });
    domWidget.serialize = false;
    node.setSize?.([Math.max(Number(node.size?.[0]) || 0, MIN_WIDTH), Math.max(Number(node.size?.[1]) || 0, MIN_HEIGHT)]);
    const connectionsChanged = node.onConnectionsChange;
    node.onConnectionsChange = function () {
        const result = connectionsChanged?.apply(this, arguments);
        setTimeout(() => { loadPlan(true); publishActiveScene(); }, 0);
        return result;
    };
    const onPromptExecuted = (event) => {
        const values = event.detail?.output?.h3_chain_active_scene;
        const scene = Array.isArray(values) ? values.at(-1) : null;
        if (!scene || String(scene.run_name ?? "") !== runName()) return;
        const shot = state.plan?.shots?.[state.active];
        const sceneId = safeShotId(
            shot?.id, `clip_${String(state.active + 1).padStart(4, "0")}`,
        );
        if (String(scene.shot_id ?? "") !== sceneId) return;
        setTimeout(() => {
            if (state.view !== "scene" || state.history.sceneKey !== historyKey(sceneId)) return;
            void loadHistory(sceneId, promptValueToText(shot.prompt), false);
        }, 50);
    };
    api.addEventListener("executed", onPromptExecuted);
    const removed = node.onRemoved;
    node.onRemoved = function () {
        if (state.pollTimer != null) clearInterval(state.pollTimer);
        if (state.checkpointTimer != null) clearInterval(state.checkpointTimer);
        if (state.planNotifyTimer != null) clearTimeout(state.planNotifyTimer);
        api.removeEventListener("executed", onPromptExecuted);
        delete node._h3PromptCompanionSetActiveScene;
        delete node._h3PromptCompanionSetScenePrompt;
        disposePlayer();
        void flushHistoryDraft(); return removed?.apply(this, arguments);
    };
    node._h3PromptCompanionSetActiveScene = (planNode, index) => {
        if (planNode !== state.planNode || !state.plan?.shots?.length) return false;
        void selectScene(index, false);
        return true;
    };
    node._h3PromptCompanionSetScenePrompt = (planNode, index, text) => {
        if (planNode !== state.planNode || !state.plan?.shots?.[index]) return false;
        state.plan.shots[index].prompt = promptTextToLines(text);
        if (index === state.active && state.history.textarea
                && state.history.textarea.value !== text) {
            const textarea = state.history.textarea;
            const focused = document.activeElement === textarea;
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.value = text;
            if (focused) textarea.setSelectionRange(
                Math.min(start, text.length), Math.min(end, text.length));
            scheduleHistoryDraft(
                String(state.plan.shots[index].id || `clip_${String(index + 1).padStart(4, "0")}`),
                text);
        }
        state.lastValue = String(state.planWidget?.value ?? state.lastValue);
        return true;
    };
    node._h3PlanStudioRefresh = () => {
        loadPlan(true);
        publishActiveScene();
    };
    state.pollTimer = setInterval(() => loadPlan(false), 500);
    state.checkpointTimer = setInterval(() => void refreshCheckpoints(), 5000);
    loadPlan(true);
}

app.registerExtension({
    name:"minimax_h3_context_loop.plan_studio",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments); setTimeout(() => mount(this), 0); return result;
        };
    },
    async nodeCreated(node) { if (nodeType(node) === NODE_NAME) mount(node); },
    async afterConfigureGraph() {
        for (const node of allNodes(app.graph)) if (nodeType(node) === NODE_NAME) setTimeout(() => node._h3PlanStudioRefresh?.(), 0);
    },
});
