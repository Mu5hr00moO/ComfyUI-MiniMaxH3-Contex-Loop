import {app} from "/scripts/app.js";
import {api} from "/scripts/api.js";
import {
    MAX_SHOTS,
    makeShot,
    parsePlanJson,
    planToJson,
    promptTextToLines,
    promptValueToText,
    sharedPrompt,
} from "./h3_chain_plan_core.mjs?v=0.4.20";
import {
    PROMPT_ASSIST_DEFAULT_INSTRUCTIONS,
    PROMPT_ASSIST_MODES,
    buildPromptAssistantContext,
    draftConflict,
    makePromptAssistRequest,
    promptSceneKey,
    promptSourceRevision,
} from "./h3_prompt_assistant_core.mjs?v=0.4.20";
import {PromptAssistantClient} from "./h3_prompt_assistant_client.mjs?v=0.4.20";
import {
    promptRevisionLabel,
    promptRevisionNavigation,
} from "./h3_prompt_history_core.mjs?v=0.4.20";
import {availableReferenceRecords} from "./h3_reference_preview_core.mjs?v=0.4.20";
import {
    PromptUndoHistory,
    promptUndoDirection,
    tokenizeRichPrompt,
} from "./h3_rich_prompt_editor_core.mjs?v=0.4.20";
import * as promptCompanionSync from "./h3_prompt_companion_sync.mjs?v=0.4.20";

const {publishCompanionScene, rebaseScenePrompt} = promptCompanionSync;
function publishCompanionPrompt(...args) {
    return promptCompanionSync.publishCompanionPrompt?.(...args) ?? 0;
}

// The compact @ reference and # dialogue authoring interactions are inspired
// by nkxx188/ComfyUI-MiniMaxH3-Easy (MIT); see THIRD_PARTY_NOTICES.md.

const NODE_NAME = "MiniMaxH3ChainScenePromptEditor";
const PLAN_NAME = "MiniMaxH3ChainPlan";
const ACTIVE_SCENE_PROPERTY = "h3_scene_prompt_editor_active_scene";
const FONT_SIZE_PROPERTY = "h3_scene_prompt_editor_font_size";
const PRESENTATION_PROPERTY = "h3_scene_prompt_editor_rich_text";
const ASSIST_PROVIDER_PROPERTY = "h3_scene_prompt_editor_assist_provider";
const ASSIST_MODE_PROPERTY = "h3_scene_prompt_editor_assist_mode";
// Keep the complete prompt-assistant implementation available for a future
// revisit, but ship the original focused editor experience for now. Re-enabling
// it is intentionally a one-line change.
const PROMPT_ASSISTANT_ENABLED = false;
const DEFAULT_FONT_SIZE = 18;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 36;

const ICONS = Object.freeze({
    picture: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m5 17 4.5-4.5 3.2 3.2 2.3-2.3 4 3.6"/></svg>',
    video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>',
    audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13v-2M8 17V7M12 20V4M16 16V8M20 13v-2"/></svg>',
    subject: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M5 21c.8-4.2 3.1-6.3 7-6.3s6.2 2.1 7 6.3"/></svg>',
    dialogue: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v11H9l-4 3z"/><path d="M8 9h8M8 12h6"/></svg>',
    reference: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/></svg>',
});

function injectStyles() {
    if (document.getElementById("h3-scene-prompt-editor-style")) return;
    const style = document.createElement("style");
    style.id = "h3-scene-prompt-editor-style";
    style.textContent = `
        .h3sp-root {
            --h3sp-bg: color-mix(in srgb, var(--comfy-menu-bg, #202124) 92%, #101827);
            --h3sp-panel: color-mix(in srgb, var(--comfy-input-bg, #111827) 84%, #263552);
            --h3sp-border: color-mix(in srgb, var(--border-color, #555) 68%, #7891bf);
            --h3sp-text: var(--input-text, #eef1f7);
            --h3sp-muted: color-mix(in srgb, var(--h3sp-text) 58%, transparent);
            /* Blend semantic foregrounds with the active ComfyUI text color.
               This keeps the pastel identity in dark themes and makes the
               same controls dark enough to read in light themes. */
            --h3sp-accent: color-mix(in srgb, var(--h3sp-text) 38%, #4f83ff);
            --h3sp-token-picture: color-mix(in srgb, var(--h3sp-text) 42%, #139be8);
            --h3sp-token-video: color-mix(in srgb, var(--h3sp-text) 42%, #9355d6);
            --h3sp-token-audio: color-mix(in srgb, var(--h3sp-text) 42%, #d47700);
            --h3sp-token-subject: color-mix(in srgb, var(--h3sp-text) 42%, #26934a);
            --h3sp-token-dialogue: color-mix(in srgb, var(--h3sp-text) 42%, #cf3976);
            --h3sp-token-danger: color-mix(in srgb, var(--h3sp-text) 42%, #d44747);
            --h3sp-font-size: 18px;
            box-sizing:border-box; width:100%; height:100%; min-height:420px;
            display:flex; flex-direction:column; gap:8px; overflow:hidden; padding:10px;
            border:1px solid var(--h3sp-border); border-radius:8px; background:var(--h3sp-bg);
            color:var(--h3sp-text); font:12px/1.35 system-ui,sans-serif;
        }
        .h3sp-root *, .h3sp-root *::before, .h3sp-root *::after { box-sizing:border-box; }
        .h3sp-head, .h3sp-nav, .h3sp-tools, .h3sp-font, .h3sp-footer {
            display:flex; align-items:center; gap:6px;
        }
        .h3sp-head { justify-content:space-between; }
        .h3sp-title { color:var(--h3sp-accent); font-size:15px; font-weight:750; }
        .h3sp-context { color:var(--h3sp-muted); white-space:nowrap; overflow:hidden;
            text-overflow:ellipsis; text-align:right; }
        .h3sp-nav select { flex:1; min-width:0; }
        .h3sp-root button, .h3sp-root select {
            color:var(--h3sp-text); font:inherit; border:1px solid var(--h3sp-border);
            border-radius:5px; background:var(--comfy-input-bg,#171a21);
        }
        .h3sp-root button { padding:6px 9px; cursor:pointer; white-space:nowrap; }
        .h3sp-root button:hover { border-color:var(--h3sp-accent); }
        .h3sp-root button:disabled { cursor:not-allowed; opacity:.4; }
        .h3sp-root select { min-height:30px; padding:5px 7px; }
        .h3sp-font { margin-left:auto; }
        .h3sp-font-value { min-width:38px; color:var(--h3sp-muted); text-align:center; }
        .h3sp-textarea {
            width:100%; min-height:240px; flex:1 1 auto; resize:none; padding:12px 14px;
            border:1px solid var(--h3sp-border); border-radius:7px;
            outline:none; background:var(--comfy-input-bg,#11141a); color:var(--h3sp-text);
            font:var(--h3sp-font-size)/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;
            tab-size:4; white-space:pre-wrap;
        }
        .h3sp-textarea:focus { border-color:var(--h3sp-accent);
            box-shadow:0 0 0 1px color-mix(in srgb,var(--h3sp-accent) 45%,transparent); }
        .h3sp-hidden { display:none !important; }
        .h3sp-editor-shell { position:relative; width:100%; min-height:240px;
            flex:1 1 auto; overflow:hidden; border:1px solid var(--h3sp-border);
            border-radius:7px; background:var(--comfy-input-bg,#11141a); }
        .h3sp-editor-shell:focus-within { border-color:var(--h3sp-accent);
            box-shadow:0 0 0 1px color-mix(in srgb,var(--h3sp-accent) 45%,transparent); }
        .h3sp-rich-editor { width:100%; height:100%; min-height:240px; overflow:auto;
            padding:12px 14px; outline:none; white-space:pre-wrap; overflow-wrap:anywhere;
            caret-color:var(--h3sp-text);
            font:var(--h3sp-font-size)/1.55 ui-monospace,SFMono-Regular,Consolas,monospace; }
        .h3sp-rich-editor:empty::before { content:attr(data-placeholder);
            color:var(--h3sp-muted); pointer-events:none; }
        .h3sp-token { display:inline-flex; align-items:center; gap:3px; max-width:320px;
            margin:0 1px; padding:1px 4px 1px 2px; border:1px solid currentColor;
            border-radius:5px; vertical-align:1px; line-height:1.25; cursor:pointer;
            user-select:all; background:color-mix(in srgb,currentColor 14%,transparent); }
        .h3sp-token-picture { color:var(--h3sp-token-picture); }
        .h3sp-token-video { color:var(--h3sp-token-video); }
        .h3sp-token-audio { color:var(--h3sp-token-audio); }
        .h3sp-token-subject { color:var(--h3sp-token-subject); }
        .h3sp-token-dialogue { color:var(--h3sp-token-dialogue); }
        .h3sp-token-unknown, .h3sp-token-inactive { color:var(--h3sp-token-danger);
            border-style:dashed; }
        .h3sp-token-icon { width:16px; height:16px; display:inline-flex;
            flex:0 0 16px; color:currentColor; }
        .h3sp-token-icon svg { width:100%; height:100%; fill:none; stroke:currentColor;
            stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
        .h3sp-token-thumb { width:18px; height:18px; flex:0 0 18px;
            object-fit:cover; border-radius:3px; background:rgba(255,255,255,.09); }
        .h3sp-token-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .h3sp-presentation-active { border-color:var(--h3sp-accent) !important;
            color:var(--h3sp-accent) !important; }
        .h3sp-popover { position:fixed; z-index:100000; width:min(360px,calc(100vw - 24px));
            padding:9px; border:1px solid #60718c; border-radius:9px; background:#171a20;
            color:#eef2f8; box-shadow:0 14px 38px rgba(0,0,0,.48);
            font:12px/1.4 system-ui,sans-serif; }
        .h3sp-popover[hidden] { display:none; }
        .h3sp-popover-title { margin-bottom:6px; font-weight:750; }
        .h3sp-popover-media { display:block; width:100%; max-height:240px;
            object-fit:contain; border-radius:6px; background:#08090c; }
        .h3sp-popover audio.h3sp-popover-media { height:42px; background:transparent; }
        .h3sp-popover-detail { margin-top:6px; color:rgba(238,242,248,.62);
            white-space:pre-wrap; overflow-wrap:anywhere; }
        .h3sp-root.h3sp-assistant-enabled { overflow:auto; }
        .h3sp-root.h3sp-assistant-enabled .h3sp-textarea {
            min-height:220px; resize:vertical;
        }
        .h3sp-tools { position:relative; flex-wrap:wrap; }
        .h3sp-hint { color:var(--h3sp-muted); margin-left:auto; }
        .h3sp-refs { display:none; flex:0 0 auto; max-height:340px; overflow:auto;
            padding:7px; gap:5px; flex-wrap:wrap; border:1px solid var(--h3sp-border);
            border-radius:6px; background:var(--h3sp-panel); }
        .h3sp-refs.h3sp-open { display:flex; }
        .h3sp-refs button { padding:4px 7px; }
        .h3sp-ref-help { flex:1 0 100%; color:var(--h3sp-muted); }
        .h3sp-ref-chip.h3sp-inactive { opacity:.48; }
        .h3sp-ref-chip.h3sp-active { border-color:#658b77; }
        .h3sp-ref-preview { display:none; flex:1 0 100%; min-height:58px;
            padding:8px; border:1px solid color-mix(in srgb,var(--h3sp-border) 74%,transparent);
            border-radius:6px; background:var(--comfy-input-bg,#11141a); }
        .h3sp-ref-preview.h3sp-visible { display:grid; grid-template-columns:minmax(120px,220px) 1fr;
            align-items:start; gap:9px; }
        .h3sp-ref-preview-media { width:100%; max-height:190px; display:block;
            border-radius:5px; object-fit:contain; background:#08090c; }
        audio.h3sp-ref-preview-media { min-width:190px; height:38px; background:transparent; }
        .h3sp-ref-preview-copy { min-width:0; color:var(--h3sp-muted);
            white-space:pre-wrap; overflow-wrap:anywhere; }
        .h3sp-ref-preview-title { color:var(--h3sp-text); font-weight:700; }
        .h3sp-footer { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);
            align-items:center; gap:8px; color:var(--h3sp-muted); }
        .h3sp-footer-status { min-width:0; overflow:hidden; text-align:right;
            text-overflow:ellipsis; white-space:nowrap; }
        .h3sp-history { min-width:0; display:flex; align-items:center;
            justify-content:center; gap:6px; color:var(--h3sp-muted); }
        .h3sp-history-nav { display:flex; align-items:center; gap:2px;
            border:1px solid color-mix(in srgb,var(--h3sp-border) 72%,transparent);
            border-radius:999px; padding:1px 3px; background:var(--comfy-input-bg,#11141a); }
        .h3sp-history-nav button { min-width:25px; padding:2px 5px; border:0;
            border-radius:999px; background:transparent; }
        .h3sp-history-count { min-width:42px; text-align:center; color:var(--h3sp-text);
            font-variant-numeric:tabular-nums; }
        .h3sp-history-meta { min-width:0; max-width:280px; overflow:hidden;
            text-overflow:ellipsis; white-space:nowrap; font-size:11px; }
        .h3sp-history-error { color:#ffb3b3; }
        .h3sp-error { padding:12px; border:1px solid #a76565; border-radius:6px;
            color:#ffb3b3; background:#351f24; white-space:pre-wrap; }
        .h3sp-assist { flex:0 0 auto; display:flex; flex-direction:column; gap:7px;
            padding:9px; border:1px solid var(--h3sp-border); border-radius:7px;
            background:var(--h3sp-panel); }
        .h3sp-assist-head, .h3sp-assist-controls, .h3sp-assist-actions,
        .h3sp-assist-contexts { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
        .h3sp-assist-head { justify-content:space-between; }
        .h3sp-assist-title { color:var(--h3sp-accent); font-size:13px; font-weight:750; }
        .h3sp-assist-status { color:var(--h3sp-muted); font-size:11px; }
        .h3sp-assist-controls select { flex:1 1 120px; min-width:100px; }
        .h3sp-assist-contexts label { display:flex; align-items:center; gap:4px;
            color:var(--h3sp-muted); cursor:pointer; }
        .h3sp-assist-contexts input { accent-color:var(--h3sp-accent); }
        .h3sp-assist-chat { display:flex; flex-direction:column; gap:5px; max-height:180px;
            overflow:auto; padding:6px; border:1px solid color-mix(in srgb,var(--h3sp-border) 70%,transparent);
            border-radius:6px; background:color-mix(in srgb,var(--comfy-input-bg,#11141a) 82%,transparent); }
        .h3sp-assist-message { padding:6px 8px; border-radius:6px; white-space:pre-wrap;
            overflow-wrap:anywhere; }
        .h3sp-assist-message-user { margin-left:12%; background:#23375b; }
        .h3sp-assist-message-agent { margin-right:7%; background:#263c34; }
        .h3sp-assist-message-system { color:var(--h3sp-muted); font-size:11px;
            border:1px dashed var(--h3sp-border); }
        .h3sp-assist-empty { color:var(--h3sp-muted); padding:5px; }
        .h3sp-assist-compose { display:flex; align-items:stretch; gap:6px; }
        .h3sp-assist-compose textarea, .h3sp-assist-draft textarea {
            width:100%; resize:vertical; min-height:58px; padding:7px 8px;
            border:1px solid var(--h3sp-border); border-radius:6px;
            outline:none; background:var(--comfy-input-bg,#11141a); color:var(--h3sp-text);
            font:12px/1.4 system-ui,sans-serif; }
        .h3sp-assist-compose textarea:focus, .h3sp-assist-draft textarea:focus {
            border-color:var(--h3sp-accent); }
        .h3sp-assist-compose button { align-self:stretch; }
        .h3sp-assist-draft { display:flex; flex-direction:column; gap:6px; padding:8px;
            border:1px solid #5d8a72; border-radius:6px; background:#182b25; }
        .h3sp-assist-draft-head { display:flex; justify-content:space-between;
            align-items:center; gap:6px; }
        .h3sp-assist-draft-title { font-weight:700; color:#9ad7b7; }
        .h3sp-assist-stale { color:#ffc08a; font-size:11px; }
        .h3sp-assist-original { color:var(--h3sp-muted); }
        .h3sp-assist-original pre { max-height:120px; overflow:auto; white-space:pre-wrap;
            padding:6px; border-radius:5px; background:var(--comfy-input-bg,#11141a); }
        .h3sp-assist-error { color:#ffb3b3; white-space:pre-wrap; }
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
    item.title = title;
    // Preserve a contenteditable selection while clicking toolbar/reference
    // controls. Keyboard focus via Tab remains available.
    item.addEventListener("pointerdown", (event) => event.preventDefault());
    item.addEventListener("click", action);
    return item;
}

function icon(kind) {
    const item = element("span", "h3sp-token-icon");
    item.innerHTML = ICONS[kind] ?? ICONS.reference;
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
        return {
            filename: String(value.filename),
            subfolder: String(value.subfolder ?? ""),
            type: String(value.type ?? "input"),
        };
    }
    let text = typeof value === "string" ? value.trim() : "";
    if (!text) return null;
    if (/^(?:blob:|data:|https?:|\/api\/view\?|\/view\?)/i.test(text)) {
        return {url: text};
    }
    let type = "input";
    const annotated = text.match(/\s+\[(input|output|temp)\]\s*$/i);
    if (annotated) {
        type = annotated[1].toLowerCase();
        text = text.slice(0, annotated.index).trim();
    }
    text = text.replaceAll("\\", "/").replace(/^\/+/, "");
    if (!mediaExtension(kind).test(text)) return null;
    const slash = text.lastIndexOf("/");
    return {
        filename: slash >= 0 ? text.slice(slash + 1) : text,
        subfolder: slash >= 0 ? text.slice(0, slash) : "",
        type,
    };
}

function assetUrl(asset) {
    if (!asset) return null;
    if (asset.url) return asset.url;
    const query = new URLSearchParams({
        filename: asset.filename,
        subfolder: asset.subfolder ?? "",
        type: asset.type ?? "input",
    });
    return api.apiURL(`/view?${query.toString()}`);
}

function previewFromNode(node, kind) {
    if (kind === "image") {
        const rendered = node?.imgs?.[0];
        const src = typeof rendered === "string" ? rendered : rendered?.src;
        if (src) return src;
    }
    for (const widget of node?.widgets ?? []) {
        const asset = widgetAsset(widget.value, kind);
        if (asset) return assetUrl(asset);
    }
    return null;
}

function findMediaPreview(start, kind) {
    const queue = [start];
    const seen = new Set();
    while (queue.length) {
        const node = queue.shift();
        if (!node || seen.has(node)) continue;
        seen.add(node);
        const url = previewFromNode(node, kind);
        if (url) return {url, source: node};
        for (const input of node.inputs ?? []) {
            const parent = inputSource(node, input.name);
            if (parent) queue.push(parent);
        }
    }
    return {url: null, source: start};
}

function insertText(textarea, text, selectionOffset = text.length) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    textarea.setRangeText(text, start, end, "end");
    const caret = start + selectionOffset;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event("input", {bubbles: true}));
    textarea.focus();
}

function insertDialogue(textarea) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const selected = textarea.value.slice(start, end);
    const markup = `<d>${selected}</d>`;
    insertText(textarea, markup, selected ? markup.length : 3);
}

function editorPlainText(editor) {
    function read(current, root) {
        if (current.nodeType === Node.TEXT_NODE) return current.textContent ?? "";
        if (current.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
            let text = "";
            for (const child of current.childNodes) text += read(child, root);
            return text;
        }
        if (current.nodeType !== Node.ELEMENT_NODE) return "";
        if (current.classList?.contains("h3sp-token")) {
            return current.dataset.token ?? current.textContent ?? "";
        }
        if (current.tagName === "BR") return "\n";
        let text = "";
        for (const child of current.childNodes) text += read(child, root);
        if (["DIV", "P"].includes(current.tagName)
                && current !== root && !text.endsWith("\n")) text += "\n";
        return text;
    }
    return read(editor, editor).replace(/\n$/, "");
}

function selectedEditorPlainText(editor) {
    const selection = globalThis.getSelection?.();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const inside = (current) => current === editor || editor.contains(current);
    if (!inside(selection.anchorNode) || !inside(selection.focusNode)) return null;
    const fragment = selection.getRangeAt(0).cloneContents();
    return editorPlainText(fragment);
}

function copyEditorSelection(editor, event, cut = false) {
    const text = selectedEditorPlainText(editor);
    if (text == null || !event.clipboardData) return false;
    // A decorated tag contains icons/thumbnails as well as its visible label.
    // Copy its canonical data-token value so another prompt editor receives
    // exactly the original prompt markup rather than browser-generated HTML.
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    if (cut) {
        const selection = globalThis.getSelection?.();
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        editor.dispatchEvent(new Event("input", {bubbles: true}));
    }
    return true;
}

function selectionTextOffset(editor) {
    const selection = globalThis.getSelection?.();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) {
        return editorPlainText(editor).length;
    }
    const range = selection.getRangeAt(0).cloneRange();
    range.selectNodeContents(editor);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    return range.toString().length;
}

function restoreCaret(editor, requested) {
    const target = Math.max(0, Number(requested) || 0);
    const range = document.createRange();
    const selection = globalThis.getSelection?.();
    let consumed = 0;
    let placed = false;
    function visit(current) {
        if (placed) return;
        if (current.nodeType === Node.TEXT_NODE) {
            const length = current.textContent?.length ?? 0;
            if (target <= consumed + length) {
                range.setStart(current, Math.max(0, target - consumed));
                placed = true;
                return;
            }
            consumed += length;
            return;
        }
        if (current.nodeType !== Node.ELEMENT_NODE) return;
        if (current.classList?.contains("h3sp-token")) {
            const length = String(current.dataset.token ?? "").length;
            if (target <= consumed + length) {
                if (target <= consumed) range.setStartBefore(current);
                else range.setStartAfter(current);
                placed = true;
                return;
            }
            consumed += length;
            return;
        }
        for (const child of current.childNodes) visit(child);
    }
    visit(editor);
    if (!placed) {
        range.selectNodeContents(editor);
        range.collapse(false);
    } else {
        range.collapse(true);
    }
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function insertPlainText(editor, text) {
    editor.focus();
    const selection = globalThis.getSelection?.();
    const inside = Boolean(selection?.rangeCount && editor.contains(selection.anchorNode));
    const range = inside ? selection.getRangeAt(0) : document.createRange();
    if (!inside) {
        range.selectNodeContents(editor);
        range.collapse(false);
    }
    range.deleteContents();
    const textNode = document.createTextNode(String(text ?? ""));
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    editor.dispatchEvent(new Event("input", {bubbles: true}));
}

function clamp(value, minimum, maximum, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric)
        ? Math.max(minimum, Math.min(maximum, Math.round(numeric))) : fallback;
}

function promptAssistantIdentityKey(node) {
    // Node ids are only unique inside one workflow. ComfyUI can keep several
    // workflows open in the same browser/sessionStorage, so include the active
    // workflow identity or two editors with (for example) node id 7 would share
    // one agent route and pending-request record.
    const workflow = app.extensionManager?.workflow?.activeWorkflow;
    const workflowIdentity = workflow?.path
        ?? workflow?.activeState?.id
        ?? workflow?.filename
        ?? "legacy-workflow";
    const nodeIdentity = node.id == null
        ? `new-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
        : String(node.id);
    return `workflow-${workflowIdentity}-node-${nodeIdentity}`;
}

function mount(node) {
    if (node._h3ScenePromptEditorMounted || typeof node.addDOMWidget !== "function") return;
    node._h3ScenePromptEditorMounted = true;
    injectStyles();

    node.properties ??= {};
    const root = element("div", "h3sp-root");
    root.classList.toggle("h3sp-assistant-enabled", PROMPT_ASSISTANT_ENABLED);
    root.title = "Edit the active scene prompt stored in the connected H3 Chain Plan.";
    for (const eventName of [
        "pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick",
    ]) {
        root.addEventListener(eventName, (event) => event.stopPropagation());
    }
    // Keep ComfyUI/LiteGraph's canvas shortcuts from claiming Ctrl/Cmd+V (and
    // the other native editing shortcuts) while focus is inside this DOM
    // widget. stopPropagation deliberately preserves the browser's default
    // textarea/contenteditable action; preventDefault here would break paste.
    for (const eventName of ["keydown", "keyup", "keypress", "copy", "cut", "paste"]) {
        root.addEventListener(eventName, (event) => event.stopPropagation());
    }
    root.addEventListener("wheel", (event) => event.stopPropagation());

    const state = {
        plan: null,
        planNode: null,
        planWidget: null,
        lastValue: "",
        lastRunName: "",
        active: Math.max(0, Number(node.properties[ACTIVE_SCENE_PROPERTY]) || 0),
        fontSize: clamp(
            node.properties[FONT_SIZE_PROPERTY], MIN_FONT_SIZE, MAX_FONT_SIZE,
            DEFAULT_FONT_SIZE,
        ),
        decorated: node.properties[PRESENTATION_PROPERTY] !== false,
        records: [],
        promptTextarea: null,
        richEditor: null,
        popover: null,
        popoverTimer: null,
        assistant: {
            client: null,
            host: null,
            status: "idle",
            statusDetail: "Connects through comfyui-mcp on the first request",
            provider: ["codex", "hermes"].includes(
                node.properties[ASSIST_PROVIDER_PROPERTY],
            ) ? node.properties[ASSIST_PROVIDER_PROPERTY] : "codex",
            mode: PROMPT_ASSIST_MODES.some(
                (item) => item.id === node.properties[ASSIST_MODE_PROPERTY],
            ) ? node.properties[ASSIST_MODE_PROPERTY] : "rewrite",
            includeShared: true,
            includeAdjacent: true,
            composer: "",
            messagesByProvider: {codex: [], hermes: []},
            drafts: new Map(),
            requestContexts: new Map(),
            activeRequest: null,
            preparingRequest: null,
            pendingStorageKey: "",
            reconnectTimer: null,
            lastApplied: null,
            providers: null,
            error: "",
        },
        history: {
            sceneKey: "",
            data: null,
            revisionId: null,
            host: null,
            textarea: null,
            status: null,
            loadToken: 0,
            loadPromise: null,
            saveTimer: null,
            pendingDraft: null,
            savePromise: null,
            error: "",
        },
        undoByScene: new Map(),
        promptUndo: null,
        richInputType: "",
        pollTimer: null,
    };
    node._h3ScenePromptEditorState = state;

    const assistant = state.assistant;
    if (PROMPT_ASSISTANT_ENABLED) {
        assistant.client = new PromptAssistantClient({
            identityKey: promptAssistantIdentityKey(node),
            onFrame: (frame) => handleAssistantFrame(frame),
            onStatus: (status, detail) => {
                assistant.status = status;
                if (status === "connected") {
                    clearAssistantReconnect();
                    assistant.statusDetail = "Connected · isolated prompt session";
                } else if (status === "connecting") {
                    assistant.statusDetail = "Connecting to comfyui-mcp…";
                } else if (assistant.activeRequest) {
                    assistant.statusDetail = "Disconnected · reconnecting to recover the active draft…";
                    scheduleAssistantReconnect();
                } else {
                    assistant.statusDetail = "Disconnected · send to reconnect";
                }
                if (detail?.providers) assistant.providers = detail.providers;
                refreshAssistant();
            },
        });
        assistant.pendingStorageKey = `h3.prompt-assistant.pending.${assistant.client.identity}`;
    }

    function dirty() {
        node.graph?.setDirtyCanvas?.(true, true);
        app.graph?.setDirtyCanvas?.(true, true);
    }

    function persistView() {
        node.properties[ACTIVE_SCENE_PROPERTY] = state.active;
        node.properties[FONT_SIZE_PROPERTY] = state.fontSize;
        node.properties[PRESENTATION_PROPERTY] = state.decorated;
        dirty();
    }

    function rebaseActivePromptOntoLivePlan() {
        if (!state.plan || !state.planWidget) return false;
        let live;
        try { live = parsePlanJson(String(state.planWidget.value ?? "")); }
        catch (_error) { return false; }
        const index = rebaseScenePrompt(state.plan, live, state.active);
        if (index < 0) return false;
        state.active = index;
        node.properties[ACTIVE_SCENE_PROPERTY] = index;
        return true;
    }

    function commitPlan(status, message = "Saved to connected Plan") {
        const value = planToJson(state.plan);
        state.lastValue = value;
        state.planWidget.value = value;
        state.planWidget.callback?.(value);
        state.planNode._h3ChainEditorRefresh?.();
        state.planNode.graph?.setDirtyCanvas?.(true, true);
        publishCompanionPrompt(
            node, state.planNode, state.active,
            promptValueToText(state.plan.shots[state.active]?.prompt));
        if (status) status.textContent = message;
        dirty();
    }

    function writePlan(status) {
        if (!state.plan || !state.planWidget || !state.planNode) return;
        // This node owns only one scene prompt. Rebase that field onto the
        // current Plan widget before every write so concurrent Studio edits to
        // timing, seed, ordering, or other scenes cannot be rolled back by a
        // briefly stale editor snapshot.
        if (!rebaseActivePromptOntoLivePlan()) {
            if (status) status.textContent = "Plan structure changed; waiting to resynchronize";
            return;
        }
        commitPlan(status);
    }

    function planRunName() {
        return String(state.planNode?.widgets?.find(
            (item) => item.name === "run_name",
        )?.value ?? "").trim();
    }

    function historySceneKey(runName, shotId) {
        return `${runName}\u0000${shotId}`;
    }

    function promptUndoForScene(shotId, text, {external = false} = {}) {
        const key = historySceneKey(planRunName(), shotId);
        let history = state.undoByScene.get(key);
        if (!history) {
            history = new PromptUndoHistory(text);
            state.undoByScene.set(key, history);
        } else if (external) {
            // Plan Studio republishes the active prompt after non-prompt edits.
            // Preserve undo when that synchronized text did not actually change.
            history.align(text);
        } else {
            history.align(text);
        }
        return history;
    }

    async function historyRequest(query = {}, body = null) {
        const suffix = new URLSearchParams(query).toString();
        const response = await api.fetchApi(
            `/minimax_h3_context_loop/prompt-history${suffix ? `?${suffix}` : ""}`,
            body == null ? undefined : {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(body),
            },
        );
        let payload = {};
        try {
            payload = await response.json();
        } catch (_error) {
            // A proxy can replace a backend error with a non-JSON response.
        }
        if (!response.ok) {
            throw new Error(payload.error || `Prompt history request failed (HTTP ${response.status}).`);
        }
        return payload;
    }

    function renderHistory() {
        const history = state.history;
        const host = history.host;
        if (!host) return;
        host.replaceChildren();
        if (history.error) {
            host.append(element("span", "h3sp-history-meta h3sp-history-error", history.error));
            return;
        }
        if (!history.data) {
            host.append(element("span", "h3sp-history-meta", "Loading prompt versions…"));
            return;
        }
        const navigation = promptRevisionNavigation(history.data, history.revisionId);
        const controls = element("span", "h3sp-history-nav");
        const previous = button("‹", "Previous prompt version", () => {
            if (navigation.previous) void selectHistoryRevision(navigation.previous.id);
        });
        const count = element(
            "span", "h3sp-history-count",
            `${navigation.position} / ${navigation.total}`,
        );
        const next = button("›", "Next prompt version", () => {
            if (navigation.next) void selectHistoryRevision(navigation.next.id);
        });
        previous.disabled = !navigation.previous;
        next.disabled = !navigation.next;
        controls.append(previous, count, next);
        const metadata = element(
            "span", "h3sp-history-meta", promptRevisionLabel(navigation),
        );
        metadata.title = metadata.textContent;
        host.append(controls, metadata);
    }

    async function loadHistory(shotId, prompt, synchronize = true) {
        const runName = planRunName();
        const history = state.history;
        const key = historySceneKey(runName, shotId);
        const token = ++history.loadToken;
        history.sceneKey = key;
        history.data = null;
        history.revisionId = null;
        history.error = "";
        renderHistory();
        if (!runName) {
            history.error = "Set a Plan run_name to enable prompt history.";
            renderHistory();
            return;
        }
        const request = synchronize
            ? historyRequest({}, {
                action: "save",
                run_name: runName,
                scene_id: shotId,
                prompt,
                parent_revision: null,
            })
            : historyRequest({run_name: runName, scene_id: shotId});
        history.loadPromise = request;
        try {
            const payload = await request;
            if (token !== history.loadToken || history.sceneKey !== key) return;
            history.data = payload.history ?? payload;
            history.revisionId = payload.revision?.id
                ?? history.data.active_revision ?? history.revisionId;
            history.error = "";
        } catch (error) {
            if (token !== history.loadToken || history.sceneKey !== key) return;
            history.error = error?.message || String(error);
        } finally {
            if (history.loadPromise === request) history.loadPromise = null;
            if (token === history.loadToken && history.sceneKey === key) renderHistory();
        }
    }

    function scheduleHistoryDraft(shotId, prompt) {
        const history = state.history;
        const runName = planRunName();
        if (!runName) return;
        history.pendingDraft = {
            key: historySceneKey(runName, shotId),
            runName,
            shotId,
            prompt,
        };
        history.error = "";
        if (history.saveTimer != null) window.clearTimeout(history.saveTimer);
        history.saveTimer = window.setTimeout(() => {
            history.saveTimer = null;
            void flushHistoryDraft();
        }, 650);
    }

    async function flushHistoryDraft() {
        const history = state.history;
        if (history.saveTimer != null) {
            window.clearTimeout(history.saveTimer);
            history.saveTimer = null;
        }
        if (history.savePromise) {
            await history.savePromise;
            return history.pendingDraft ? flushHistoryDraft() : undefined;
        }
        const draft = history.pendingDraft;
        if (!draft) return;
        history.pendingDraft = null;
        if (history.loadPromise && history.sceneKey === draft.key) {
            await history.loadPromise;
        }
        const parent = history.sceneKey === draft.key ? history.revisionId : null;
        const request = historyRequest({}, {
            action: "save",
            run_name: draft.runName,
            scene_id: draft.shotId,
            prompt: draft.prompt,
            parent_revision: parent,
        });
        history.savePromise = request;
        try {
            const payload = await request;
            if (history.sceneKey === draft.key) {
                history.data = payload.history;
                history.revisionId = payload.revision?.id ?? payload.history?.active_revision;
                history.error = "";
                renderHistory();
            }
        } catch (error) {
            if (history.sceneKey === draft.key) {
                history.error = error?.message || String(error);
                renderHistory();
            }
        } finally {
            if (history.savePromise === request) history.savePromise = null;
        }
        if (history.pendingDraft) await flushHistoryDraft();
    }

    async function selectHistoryRevision(revisionId) {
        await flushHistoryDraft();
        const history = state.history;
        const shot = state.plan?.shots?.[state.active];
        if (!shot || !history.textarea) return;
        const shotId = String(shot.id || `clip_${String(state.active + 1).padStart(4, "0")}`);
        const runName = planRunName();
        const key = historySceneKey(runName, shotId);
        try {
            const payload = await historyRequest({}, {
                action: "activate",
                run_name: runName,
                scene_id: shotId,
                revision: revisionId,
            });
            if (history.sceneKey !== key) return;
            history.data = payload.history;
            history.revisionId = payload.revision.id;
            history.error = "";
            history.textarea.value = String(payload.revision.prompt ?? "");
            state.promptUndo?.record(history.textarea.value, {
                inputType: "insertReplacementText",
            });
            renderRichEditorText(history.textarea.value);
            shot.prompt = promptTextToLines(history.textarea.value);
            writePlan(history.status);
            if (history.status) history.status.textContent = "Loaded prompt version";
            renderHistory();
            history.textarea.focus();
        } catch (error) {
            if (history.sceneKey !== key) return;
            history.error = error?.message || String(error);
            renderHistory();
        }
    }

    function messagesForProvider(provider = assistant.provider) {
        const key = provider === "hermes" ? "hermes" : "codex";
        assistant.messagesByProvider[key] ??= [];
        return assistant.messagesByProvider[key];
    }

    function assistantMessage(role, text, provider = assistant.provider) {
        const value = String(text ?? "").trim();
        if (!value) return;
        const messages = messagesForProvider(provider);
        messages.push({role, text: value});
        assistant.messagesByProvider[provider === "hermes" ? "hermes" : "codex"] = messages.slice(-24);
    }

    function clearAssistantReconnect() {
        if (assistant.reconnectTimer != null) {
            window.clearTimeout(assistant.reconnectTimer);
            assistant.reconnectTimer = null;
        }
    }

    function scheduleAssistantReconnect(delay = 500) {
        if (!assistant.activeRequest || assistant.reconnectTimer != null) return;
        assistant.reconnectTimer = window.setTimeout(async () => {
            assistant.reconnectTimer = null;
            if (!assistant.activeRequest) return;
            try {
                await assistant.client.connect();
            } catch (_error) {
                if (assistant.activeRequest) scheduleAssistantReconnect(1_000);
            }
        }, delay);
    }

    function persistPendingRequest(requestId, meta) {
        try {
            globalThis.sessionStorage?.setItem(assistant.pendingStorageKey, JSON.stringify({
                requestId,
                ...meta,
            }));
        } catch (_error) {
            // Recovery across reload is best-effort; live correlation still works.
        }
    }

    function clearPendingRequest(requestId = null) {
        if (requestId && assistant.activeRequest && assistant.activeRequest !== requestId) return;
        try { globalThis.sessionStorage?.removeItem(assistant.pendingStorageKey); } catch (_error) { /* unavailable */ }
    }

    function restorePendingRequest() {
        let stored = null;
        try {
            stored = JSON.parse(globalThis.sessionStorage?.getItem(assistant.pendingStorageKey) || "null");
        } catch (_error) {
            clearPendingRequest();
        }
        if (!stored || typeof stored !== "object" || typeof stored.requestId !== "string") return;
        const meta = {
            sceneKey: String(stored.sceneKey || ""),
            sceneId: String(stored.sceneId || ""),
            sceneIndex: Number(stored.sceneIndex),
            sourcePrompt: String(stored.sourcePrompt ?? ""),
            sourceRevision: String(stored.sourceRevision || ""),
            provider: stored.provider === "hermes" ? "hermes" : "codex",
        };
        if (!meta.sceneKey || !meta.sceneId || !Number.isInteger(meta.sceneIndex) || !meta.sourceRevision) {
            clearPendingRequest();
            return;
        }
        assistant.provider = meta.provider;
        assistant.activeRequest = stored.requestId;
        assistant.requestContexts.set(stored.requestId, meta);
        assistant.status = "connecting";
        assistant.statusDetail = "Reconnecting to recover the active draft…";
        refreshAssistant();
        scheduleAssistantReconnect(0);
    }

    function reconcileAssistantProvider() {
        // A restored in-flight request remains owned by its original provider.
        // Switching the visible lane during recovery would hide its reply in a
        // different provider transcript.
        if (assistant.activeRequest) return;
        const selected = assistant.providers?.find((item) => item.id === assistant.provider);
        if (selected?.available !== false) return;
        const fallback = assistant.providers?.find((item) => item.available !== false);
        if (!fallback || !["codex", "hermes"].includes(fallback.id)) return;
        const unavailable = assistant.provider === "hermes" ? "Hermes" : "Codex";
        assistant.provider = fallback.id;
        node.properties[ASSIST_PROVIDER_PROPERTY] = assistant.provider;
        assistantMessage("system", `${unavailable} is unavailable; using ${fallback.label || fallback.id}.`, assistant.provider);
        dirty();
    }

    function assistantProviderAvailable(provider = assistant.provider) {
        return assistant.providers?.find((item) => item.id === provider)?.available !== false;
    }

    function refreshAssistant() {
        const host = assistant.host;
        const promptTextarea = root.querySelector(".h3sp-textarea");
        if (!host || !promptTextarea || !state.plan?.shots?.length) return;
        renderAssistant(host, promptTextarea);
    }

    function handleAssistantFrame(frame) {
        if (!frame || typeof frame !== "object") return;
        if (frame.type === "prompt_assist_ready") {
            assistant.providers = Array.isArray(frame.providers) ? frame.providers : null;
            reconcileAssistantProvider();
            assistant.error = "";
        } else if (frame.type === "prompt_assist_started") {
            if (frame.request_id === assistant.activeRequest) assistant.status = "working";
        } else if (frame.type === "prompt_assist_progress") {
            if (frame.request_id === assistant.activeRequest) assistant.statusDetail = "Agent is drafting…";
        } else if (frame.type === "prompt_assist_result") {
            // Accept only a request this editor incarnation has in its live or
            // sessionStorage-restored correlation map. A disconnected "New
            // chat" can reconnect to a buffered result before its reset frame
            // reaches the server; reconstructing metadata from that result
            // would resurrect a draft the user explicitly discarded.
            const meta = assistant.requestContexts.get(frame.request_id);
            if (!meta) return;
            assistant.requestContexts.delete(frame.request_id);
            if (assistant.activeRequest === frame.request_id) assistant.activeRequest = null;
            clearPendingRequest(frame.request_id);
            clearAssistantReconnect();
            assistant.status = "connected";
            assistant.statusDetail = "Connected · isolated prompt session";
            assistant.error = "";
            assistantMessage("agent", frame.message || "Draft ready.", meta.provider);
            if (typeof frame.rewritten_prompt === "string" && frame.rewritten_prompt.trim()) {
                assistant.drafts.set(meta.sceneKey, {
                    sceneId: meta.sceneId,
                    sceneIndex: meta.sceneIndex,
                    sourcePrompt: meta.sourcePrompt,
                    sourceRevision: meta.sourceRevision,
                    proposed: frame.rewritten_prompt,
                    provider: frame.provider || meta.provider,
                });
            } else if (typeof frame.rewritten_prompt === "string") {
                assistant.error = "The agent returned an empty draft, so it was not staged.";
            }
        } else if (frame.type === "prompt_assist_error") {
            const meta = assistant.requestContexts.get(frame.request_id);
            if (frame.request_id && !meta && assistant.activeRequest !== frame.request_id) return;
            if (meta) assistant.requestContexts.delete(frame.request_id);
            if (!frame.request_id || assistant.activeRequest === frame.request_id) {
                assistant.activeRequest = null;
            }
            clearPendingRequest(frame.request_id);
            clearAssistantReconnect();
            assistant.status = assistant.client?.socket?.readyState === WebSocket.OPEN
                ? "connected" : "disconnected";
            assistant.error = String(frame.error || "Prompt assistant failed.");
            assistantMessage("system", `Agent error: ${assistant.error}`, meta?.provider);
        } else if (frame.type === "prompt_assist_cancelled") {
            const meta = assistant.requestContexts.get(frame.request_id);
            if (!meta && assistant.activeRequest !== frame.request_id) return;
            assistant.requestContexts.delete(frame.request_id);
            if (assistant.activeRequest === frame.request_id) assistant.activeRequest = null;
            clearPendingRequest(frame.request_id);
            clearAssistantReconnect();
            assistant.status = "connected";
            assistant.statusDetail = "Stopped · ready for another request";
            assistantMessage("system", "Request stopped. The scene prompt was not changed.", meta?.provider);
        } else if (
            frame.type === "prompt_assist_cancel_ack"
            && frame.cancelled === false
            && frame.request_id === assistant.activeRequest
        ) {
            // The orchestrator may have restarted while the browser retained a
            // pending request. A negative correlated ack proves there is no
            // server-side turn left to wait for.
            const meta = assistant.requestContexts.get(frame.request_id);
            assistant.requestContexts.delete(frame.request_id);
            assistant.activeRequest = null;
            clearPendingRequest(frame.request_id);
            clearAssistantReconnect();
            assistant.status = assistant.client?.socket?.readyState === WebSocket.OPEN
                ? "connected" : "disconnected";
            assistant.statusDetail = "No active server request · ready for another request";
            assistant.error = "The prior request is no longer active, likely because the bridge restarted.";
            assistantMessage("system", assistant.error, meta?.provider);
        }
        refreshAssistant();
    }

    async function sendAssistant(promptTextarea) {
        if (assistant.activeRequest || assistant.preparingRequest || !state.plan?.shots?.length) return;
        // Snapshot the selected scene before the asynchronous bridge handshake.
        // Navigation remains usable while connecting; reading state.active and
        // an old textarea after await could otherwise pair scene B's id with
        // scene A's prompt.
        const requestSceneIndex = state.active;
        const requestShot = state.plan.shots[requestSceneIndex];
        const sourcePrompt = promptTextarea.value;
        const selectedText = sourcePrompt.slice(
            promptTextarea.selectionStart ?? 0,
            promptTextarea.selectionEnd ?? 0,
        );
        const context = buildPromptAssistantContext(
            state.plan,
            requestSceneIndex,
            sourcePrompt,
            {
                includeShared: assistant.includeShared,
                includeAdjacent: assistant.includeAdjacent,
                selectedText,
            },
        );
        const preparation = {};
        assistant.preparingRequest = preparation;
        assistant.status = "connecting";
        assistant.statusDetail = "Connecting to comfyui-mcp…";
        assistant.error = "";
        refreshAssistant();
        try {
            // Wait for prompt_assist_ready before freezing the provider into the
            // request. The ready frame may switch a persisted unavailable Hermes
            // selection to Codex.
            await assistant.client.connect();
        } catch (error) {
            // New chat may have invalidated this connect attempt while it was
            // awaiting the handshake. In that case it owns no UI state.
            if (assistant.preparingRequest !== preparation) return;
            assistant.preparingRequest = null;
            assistant.status = "disconnected";
            assistant.error = error.message || String(error);
            assistantMessage("system", `Could not connect: ${assistant.error}`);
            refreshAssistant();
            return;
        }
        if (assistant.preparingRequest !== preparation) return;
        assistant.preparingRequest = null;
        if (!assistantProviderAvailable()) {
            assistant.error = `${assistant.provider === "hermes" ? "Hermes" : "Codex"} is unavailable.`;
            refreshAssistant();
            return;
        }
        const sceneId = String(requestShot.id || `clip_${String(requestSceneIndex + 1).padStart(4, "0")}`);
        const sceneKey = promptSceneKey(sceneId, requestSceneIndex);
        const requestId = `pa-${globalThis.crypto?.randomUUID?.()
            ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
        const request = makePromptAssistRequest({
            requestId,
            conversationId: assistant.client.conversationId,
            provider: assistant.provider,
            mode: assistant.mode,
            instruction: assistant.composer,
            context,
        });
        assistant.requestContexts.set(requestId, {
            sceneKey,
            sceneId,
            sceneIndex: requestSceneIndex,
            sourcePrompt,
            sourceRevision: request.source_revision,
            provider: assistant.provider,
        });
        const requestMeta = assistant.requestContexts.get(requestId);
        assistant.activeRequest = requestId;
        persistPendingRequest(requestId, requestMeta);
        assistant.status = "working";
        assistant.statusDetail = `Asking ${assistant.provider === "hermes" ? "Hermes" : "Codex"}…`;
        assistant.error = "";
        assistantMessage("user", request.instruction);
        assistant.composer = "";
        refreshAssistant();
        try {
            await assistant.client.send(request);
        } catch (error) {
            if (assistant.activeRequest !== requestId) return;
            assistant.activeRequest = null;
            assistant.requestContexts.delete(requestId);
            clearPendingRequest(requestId);
            clearAssistantReconnect();
            assistant.status = "disconnected";
            assistant.error = error.message || String(error);
            assistantMessage("system", `Could not send: ${assistant.error}`);
            refreshAssistant();
        }
    }

    function stopAssistant() {
        if (!assistant.activeRequest) return;
        if (!assistant.client.cancel(assistant.activeRequest)) {
            assistant.error = "The bridge is disconnected; the local request may finish without being delivered.";
            refreshAssistant();
        } else {
            assistant.statusDetail = "Stopping agent…";
            refreshAssistant();
        }
    }

    function resetAssistantChat() {
        if (assistant.activeRequest) assistant.client.cancel(assistant.activeRequest);
        assistant.client.reset();
        assistant.activeRequest = null;
        assistant.preparingRequest = null;
        clearPendingRequest();
        clearAssistantReconnect();
        assistant.requestContexts.clear();
        assistant.messagesByProvider = {codex: [], hermes: []};
        assistant.error = "";
        assistant.statusDetail = "New isolated conversation";
        refreshAssistant();
    }

    function copyAssistantDraft(draft) {
        const operation = navigator.clipboard?.writeText?.(draft.proposed);
        if (!operation) {
            assistant.error = "Clipboard access is unavailable. Select the proposed text and copy it manually.";
            refreshAssistant();
            return;
        }
        operation.then(() => {
            assistantMessage("system", "Proposed prompt copied.");
            refreshAssistant();
        }).catch(() => {
            assistant.error = "Clipboard access was refused. Select the proposed text and copy it manually.";
            refreshAssistant();
        });
    }

    function applyAssistantDraft(draft, promptTextarea, conflict) {
        if (conflict.stale && !window.confirm(
            `${conflict.reason}\n\nApply this draft anyway and replace the current scene prompt?`,
        )) return;
        const before = promptTextarea.value;
        const after = draft.proposed;
        if (!String(after).trim()) {
            assistant.error = "An empty assistant draft cannot replace the scene prompt.";
            refreshAssistant();
            return;
        }
        assistant.lastApplied = {
            sceneKey: promptSceneKey(draft.sceneId, draft.sceneIndex),
            before,
            after,
        };
        promptTextarea.value = after;
        promptTextarea.dispatchEvent(new Event("input", {bubbles: true}));
        assistant.drafts.delete(promptSceneKey(draft.sceneId, draft.sceneIndex));
        assistantMessage("system", "Draft applied to the active scene and saved in the connected Plan.");
        refreshAssistant();
    }

    function undoAssistantApply(promptTextarea, sceneKey) {
        const undo = assistant.lastApplied;
        if (!undo || undo.sceneKey !== sceneKey || promptTextarea.value !== undo.after) return;
        promptTextarea.value = undo.before;
        promptTextarea.dispatchEvent(new Event("input", {bubbles: true}));
        assistant.lastApplied = null;
        assistantMessage("system", "The last assistant apply was undone.");
        refreshAssistant();
    }

    function renderAssistant(host, promptTextarea) {
        host.replaceChildren();
        const shot = state.plan.shots[state.active];
        const sceneId = String(shot.id || `clip_${String(state.active + 1).padStart(4, "0")}`);
        const sceneKey = promptSceneKey(sceneId, state.active);

        const head = element("div", "h3sp-assist-head");
        const heading = element("span", "h3sp-assist-title", "Prompt Assistant");
        const busy = Boolean(assistant.activeRequest || assistant.preparingRequest);
        const statusText = busy
            ? assistant.statusDetail || "Agent is working…"
            : assistant.statusDetail;
        head.append(heading, element("span", "h3sp-assist-status", statusText));

        const controls = element("div", "h3sp-assist-controls");
        const provider = element("select");
        provider.title = "Choose which isolated local agent handles this prompt turn.";
        for (const [id, label] of [["codex", "Codex"], ["hermes", "Hermes"]]) {
            const option = element("option", "", label);
            option.value = id;
            const available = assistant.providers?.find((item) => item.id === id)?.available;
            if (available === false) {
                option.textContent = `${label} (not found)`;
                option.disabled = true;
            }
            provider.append(option);
        }
        provider.value = assistant.provider;
        provider.disabled = busy;
        provider.addEventListener("change", () => {
            assistant.provider = provider.value;
            node.properties[ASSIST_PROVIDER_PROPERTY] = assistant.provider;
            persistView();
            refreshAssistant();
        });
        const mode = element("select");
        mode.title = "Choose the kind of help to request.";
        for (const item of PROMPT_ASSIST_MODES) {
            const option = element("option", "", item.label);
            option.value = item.id;
            mode.append(option);
        }
        mode.value = assistant.mode;
        mode.disabled = busy;
        mode.addEventListener("change", () => {
            assistant.mode = mode.value;
            node.properties[ASSIST_MODE_PROPERTY] = assistant.mode;
            persistView();
            refreshAssistant();
        });
        controls.append(provider, mode, button("New chat", "Clear agent conversation; staged drafts remain.", resetAssistantChat));

        const chat = element("div", "h3sp-assist-chat");
        const messages = messagesForProvider();
        if (!messages.length) {
            chat.append(element(
                "div", "h3sp-assist-empty",
                "Ask for a rewrite, continuity pass, critique, or a specific change. Nothing is applied until you press Apply.",
            ));
        } else {
            for (const message of messages) {
                chat.append(element(
                    "div",
                    `h3sp-assist-message h3sp-assist-message-${message.role}`,
                    message.text,
                ));
            }
            setTimeout(() => { chat.scrollTop = chat.scrollHeight; }, 0);
        }

        const draft = assistant.drafts.get(sceneKey);
        let draftPanel = null;
        if (draft) {
            const conflict = draftConflict(draft, sceneId, promptTextarea.value);
            draftPanel = element("div", "h3sp-assist-draft");
            const draftHead = element("div", "h3sp-assist-draft-head");
            draftHead.append(
                element("span", "h3sp-assist-draft-title", `Staged ${draft.provider || "agent"} proposal`),
                conflict.stale ? element("span", "h3sp-assist-stale", conflict.reason) : element("span"),
            );
            const proposed = element("textarea");
            proposed.value = draft.proposed;
            proposed.title = "You can edit the staged proposal before applying it.";
            proposed.addEventListener("input", () => { draft.proposed = proposed.value; });
            const original = element("details", "h3sp-assist-original");
            original.append(
                element("summary", "", "Compare with original"),
                element("pre", "", draft.sourcePrompt),
            );
            const actions = element("div", "h3sp-assist-actions");
            actions.append(
                button(
                    conflict.stale ? "Apply anyway…" : "Apply to scene",
                    "Replace the real active scene prompt in the connected Plan.",
                    () => applyAssistantDraft(draft, promptTextarea, conflict),
                ),
                button("Copy", "Copy the proposed prompt without changing the Plan.", () => copyAssistantDraft(draft)),
                button("Discard", "Remove this staged proposal without changing the Plan.", () => {
                    assistant.drafts.delete(sceneKey);
                    refreshAssistant();
                }),
            );
            draftPanel.append(draftHead, proposed, original, actions);
        }

        const contexts = element("div", "h3sp-assist-contexts");
        const contextToggle = (label, checked, change, title) => {
            const wrapper = element("label");
            wrapper.title = title;
            const input = element("input");
            input.type = "checkbox";
            input.checked = checked;
            input.disabled = busy;
            input.addEventListener("change", () => change(input.checked));
            wrapper.append(input, document.createTextNode(label));
            return wrapper;
        };
        contexts.append(
            contextToggle("Shared prompt", assistant.includeShared, (value) => {
                assistant.includeShared = value;
            }, "Include the Plan's shared/global prompt as read-only context."),
            contextToggle("Previous + next", assistant.includeAdjacent, (value) => {
                assistant.includeAdjacent = value;
            }, "Include adjacent scene prompts for continuity advice."),
            element("span", "h3sp-assist-status", "Selected text is included automatically"),
        );

        const compose = element("div", "h3sp-assist-compose");
        const composer = element("textarea");
        composer.value = assistant.composer;
        composer.placeholder = PROMPT_ASSIST_DEFAULT_INSTRUCTIONS[assistant.mode];
        composer.disabled = busy;
        composer.addEventListener("input", () => { assistant.composer = composer.value; });
        composer.addEventListener("keydown", (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                void sendAssistant(promptTextarea);
            }
        });
        const send = button("Ask agent", "Send (Ctrl/Cmd+Enter). The response is staged, never auto-applied.", () => {
            void sendAssistant(promptTextarea);
        });
        send.disabled = busy || !assistantProviderAvailable();
        compose.append(composer, send);
        if (assistant.activeRequest) {
            compose.append(button("Stop", "Interrupt this prompt-assist request.", stopAssistant));
        }

        const error = assistant.error
            ? element("div", "h3sp-assist-error", assistant.error) : null;
        const undo = assistant.lastApplied;
        const undoButton = undo?.sceneKey === sceneKey && promptTextarea.value === undo.after
            ? button("Undo last apply", "Restore the prompt that existed before the last assistant Apply.", () => {
                undoAssistantApply(promptTextarea, sceneKey);
            }) : null;

        host.append(head, controls, chat);
        if (draftPanel) host.append(draftPanel);
        host.append(contexts, compose);
        if (undoButton) host.append(undoButton);
        if (error) host.append(error);
    }

    function showFailure(message) {
        assistant.host = null;
        state.promptTextarea = null;
        state.richEditor = null;
        state.history.host = null;
        state.history.textarea = null;
        state.history.status = null;
        root.replaceChildren();
        root.append(
            element("div", "h3sp-title", "MiniMax H3 Scene Prompt Editor"),
            element("div", "h3sp-error", message),
            element("div", "h3sp-context", "Connect the Plan output to this node's plan input."),
        );
        hidePopover();
    }

    function navigate(offset, absolute = null, {synchronize = true, focus = true} = {}) {
        if (!state.plan?.shots?.length) return;
        void (async () => {
            await flushHistoryDraft();
            const requested = absolute == null ? state.active + offset : Number(absolute);
            state.active = Math.max(0, Math.min(state.plan.shots.length - 1, requested));
            persistView();
            render();
            if (synchronize) publishCompanionScene(node, state.planNode, state.active);
            if (focus) (state.decorated ? state.richEditor : state.promptTextarea)?.focus();
        })();
    }

    async function appendScene() {
        if (!state.plan || state.plan.shots.length >= MAX_SHOTS) return;
        await flushHistoryDraft();
        // This is the one structural operation exposed by the focused editor.
        // Start from the live Plan so Studio/timing edits cannot be overwritten,
        // then append instead of inserting into the middle of an active chain.
        if (!rebaseActivePromptOntoLivePlan()) return;
        state.plan.shots.push(makeShot(state.plan.shots));
        state.active = state.plan.shots.length - 1;
        persistView();
        commitPlan(null);
        render();
        publishCompanionScene(node, state.planNode, state.active);
        (state.decorated ? state.richEditor : state.promptTextarea)?.focus();
    }

    function hidePopover() {
        if (state.popoverTimer != null) {
            window.clearTimeout(state.popoverTimer);
            state.popoverTimer = null;
        }
        if (state.popover) state.popover.hidden = true;
    }

    function scheduleHidePopover() {
        if (state.popoverTimer != null) window.clearTimeout(state.popoverTimer);
        state.popoverTimer = window.setTimeout(hidePopover, 140);
    }

    function showTokenPopover(record, anchor) {
        hidePopover();
        const popover = state.popover ?? element("div", "h3sp-popover");
        if (!state.popover) {
            popover.hidden = true;
            popover.addEventListener("mouseenter", () => {
                if (state.popoverTimer != null) window.clearTimeout(state.popoverTimer);
            });
            popover.addEventListener("mouseleave", scheduleHidePopover);
            document.body.append(popover);
            state.popover = popover;
        }
        popover.replaceChildren(element("div", "h3sp-popover-title", record.token));
        const mediaKind = record.kind === "picture" ? "image" : record.kind;
        const media = findMediaPreview(record.source, mediaKind);
        if (media.url) {
            const mediaElement = element(
                mediaKind === "image" ? "img" : mediaKind === "video" ? "video" : "audio",
                "h3sp-popover-media",
            );
            mediaElement.src = media.url;
            if (mediaKind !== "image") {
                mediaElement.controls = true;
                mediaElement.preload = "metadata";
            } else {
                mediaElement.alt = `Preview for ${record.token}`;
            }
            popover.append(mediaElement);
        } else {
            popover.append(element(
                "div", "h3sp-popover-detail", "No browser-playable file preview was found upstream.",
            ));
        }
        const sourceTitle = media.source?.title || nodeType(media.source) || "unresolved source";
        popover.append(element(
            "div", "h3sp-popover-detail",
            `${record.kind.toUpperCase()} · scenes ${record.selector}\n` +
            `${record.active ? "Active" : "Inactive"} in scene ${state.active + 1}\n` +
            `Source: ${sourceTitle}`,
        ));
        popover.hidden = false;
        const rect = anchor.getBoundingClientRect();
        const width = Math.min(360, globalThis.innerWidth - 24);
        popover.style.left = `${Math.max(12, Math.min(globalThis.innerWidth - width - 12, rect.left))}px`;
        popover.style.top = `${Math.max(12, Math.min(
            globalThis.innerHeight - popover.offsetHeight - 12, rect.bottom + 7,
        ))}px`;
    }

    function makeRichToken(part) {
        if (part.type === "text") return document.createTextNode(part.text);
        const kind = part.type === "reference" ? part.kind : part.type;
        const token = element("span", `h3sp-token h3sp-token-${kind}`);
        token.contentEditable = "false";
        token.dataset.token = part.text;
        if (part.unresolved) token.classList.add("h3sp-token-unknown");
        if (part.record && !part.record.active) token.classList.add("h3sp-token-inactive");
        const mediaKind = kind === "picture" ? "image" : kind;
        const media = part.record?.source ? findMediaPreview(part.record.source, mediaKind) : null;
        if (kind === "picture" && media?.url) {
            const thumbnail = element("img", "h3sp-token-thumb");
            thumbnail.src = media.url;
            thumbnail.alt = "";
            token.append(thumbnail);
        } else {
            token.append(icon(kind));
        }
        token.append(element("span", "h3sp-token-label", part.text));
        if (part.record) {
            token.title = `${part.text} · hover for ${kind} preview`;
            token.addEventListener("mouseenter", () => showTokenPopover(part.record, token));
            token.addEventListener("mouseleave", scheduleHidePopover);
            token.addEventListener("focus", () => showTokenPopover(part.record, token));
        } else {
            token.title = part.type === "reference"
                ? "Unresolved reference in this scene" : part.text;
        }
        return token;
    }

    function renderRichEditorText(text, caret = null) {
        if (!state.richEditor) return;
        const parts = tokenizeRichPrompt(String(text ?? ""), state.records);
        const fragment = document.createDocumentFragment();
        for (let index = 0; index < parts.length; index += 1) {
            const part = parts[index];
            const unfinished = part.type === "reference" && part.unresolved
                && part.text.startsWith("@") && index === parts.length - 1
                && document.activeElement === state.richEditor;
            fragment.append(unfinished ? document.createTextNode(part.text) : makeRichToken(part));
        }
        state.richEditor.replaceChildren(fragment);
        if (caret != null) restoreCaret(state.richEditor, caret);
    }

    function insertPromptText(text) {
        if (state.decorated && state.richEditor) {
            insertPlainText(state.richEditor, text);
            const caret = selectionTextOffset(state.richEditor);
            renderRichEditorText(editorPlainText(state.richEditor), caret);
        } else if (state.promptTextarea) {
            insertText(state.promptTextarea, text);
        }
    }

    function insertPromptDialogue() {
        if (state.decorated && state.richEditor) {
            const selection = globalThis.getSelection?.();
            const selected = selection?.rangeCount ? selection.toString() : "";
            insertPromptText(`<d>${selected}</d>`);
        } else if (state.promptTextarea) {
            insertDialogue(state.promptTextarea);
        }
    }

    function showReferencePreview(record, preview) {
        preview.replaceChildren();
        preview.classList.add("h3sp-visible");
        const mediaKind = record.kind === "picture" ? "image" : record.kind;
        const media = findMediaPreview(record.source, mediaKind);
        if (media.url) {
            const mediaElement = element(mediaKind === "image" ? "img"
                : mediaKind === "video" ? "video" : "audio",
            "h3sp-ref-preview-media");
            mediaElement.src = media.url;
            if (mediaKind !== "image") {
                mediaElement.controls = true;
                mediaElement.preload = "metadata";
            } else {
                mediaElement.alt = `Preview for ${record.token}`;
                mediaElement.loading = "lazy";
            }
            preview.append(mediaElement);
        } else {
            preview.append(element(
                "div", "h3sp-ref-preview-copy",
                "No browser-playable source was found. Dynamic tensors can " +
                "still run in the generation graph, but need an upstream loaded file for an editor preview.",
            ));
        }

        const sourceTitle = media.source?.title || nodeType(media.source) || "unresolved source";
        const mapping = record.active
            ? `${record.label} in scene ${state.active + 1}`
            : `inactive in scene ${state.active + 1}`;
        const previewTitle = record.mode === "native"
            ? record.token : `${record.token} → ${mapping}`;
        const copy = element("div", "h3sp-ref-preview-copy");
        copy.append(
            element("div", "h3sp-ref-preview-title", previewTitle),
            document.createTextNode(
                `\n${record.kind.toUpperCase()} · ${record.selector === "prompt tag" ? "activated by prompt tag" : `scenes ${record.selector}`}` +
                `\nSource: ${sourceTitle}`,
            ),
        );
        preview.append(copy);
    }

    function renderReferenceTray(refs) {
        refs.replaceChildren();
        const referenceData = availableReferenceRecords(
            node, state.active + 1, {
                includeInactive: true,
                prompt: [
                    sharedPrompt(state.plan).text.trim(),
                    state.promptTextarea?.value?.trim() ?? "",
                ].filter(Boolean).join("\n\n"),
            },
        );
        const {mode, wrapper} = referenceData;
        const records = mode === "tagged"
            ? referenceData.records
            : referenceData.records.filter((record) => record.active);
        const preview = element("div", "h3sp-ref-preview");
        if (!records.length) {
            refs.append(element(
                "div", "h3sp-ref-help",
                wrapper
                    ? `No connected references are active in scene ${state.active + 1}.`
                    : "No connected Tagged/Scheduled Ref2VA, core Ref2VA, or core I2V/FL2V references were found. The menu does not invent unavailable labels.",
            ));
            return;
        }

        const help = mode === "tagged"
            ? "Prompt-driven references. Hover to preview; click a @tag to insert it. " +
              "Writing the tag activates that asset for this scene and compiles it " +
              "to a compact native H3 label. Audio never autoplays."
            : mode === "scheduled"
            ? `Scheduled references for scene ${state.active + 1}. Hover to preview; ` +
              "click to insert the optional stable @alias. It compiles to a native label; " +
              "the scheduler inserts no prompt text. Audio never autoplays."
            : mode === "native_keyframes"
              ? `Core I2V/FL2V keyframes for scene ${state.active + 1}. ` +
                "A first-scene gate is shown inactive on continuations. " +
                "Hover to preview; click to insert the native Picture label."
              : "Core Ref2VA references. Hover to preview; click to insert the " +
                "native label. Audio never autoplays.";
        refs.append(element("div", "h3sp-ref-help", help));
        const icons = {picture: "▧", video: "▶", audio: "♫"};
        for (const record of records) {
            const aliasMode = mode === "scheduled" || mode === "tagged";
            const mapping = aliasMode && record.label
                ? ` → ${record.label}` : "";
            const chip = button(
                `${icons[record.kind] ?? "@"} ${record.token}${mapping}`,
                aliasMode
                    ? `Insert ${record.token}; it activates this reference and compiles to a native label in this scene.`
                    : `Insert ${record.token} for the connected core conditioning input.`,
                () => {
                    insertPromptText(record.token);
                    refs.classList.remove("h3sp-open");
                },
            );
            chip.classList.add("h3sp-ref-chip");
            chip.classList.toggle("h3sp-active", record.active);
            chip.addEventListener("mouseenter", () => showReferencePreview(record, preview));
            chip.addEventListener("focus", () => showReferencePreview(record, preview));
            refs.append(chip);
        }
        refs.append(preview);
        showReferencePreview(records[0], preview);
    }

    function render() {
        if (!state.plan?.shots?.length) {
            showFailure("The connected Plan has no scenes.");
            return;
        }
        hidePopover();
        state.active = Math.max(0, Math.min(state.active, state.plan.shots.length - 1));
        root.style.setProperty("--h3sp-font-size", `${state.fontSize}px`);
        assistant.host = null;
        root.replaceChildren();

        const shot = state.plan.shots[state.active];
        const shotId = String(shot.id || `clip_${String(state.active + 1).padStart(4, "0")}`);
        const head = element("div", "h3sp-head");
        head.append(
            element("span", "h3sp-title", "Scene Prompt Editor"),
            element("span", "h3sp-context", sharedPrompt(state.plan).text.trim()
                ? "Shared prompt active (unchanged)" : "No shared prompt"),
        );

        const nav = element("div", "h3sp-nav");
        const previous = button("←", "Previous scene (Alt+Left)", () => navigate(-1));
        const next = button("→", "Next scene (Alt+Right)", () => navigate(1));
        const add = button("+", "Append a new scene and select it", () => void appendScene());
        previous.disabled = state.active === 0;
        next.disabled = state.active === state.plan.shots.length - 1;
        add.disabled = state.plan.shots.length >= MAX_SHOTS;
        const sceneSelect = element("select");
        for (let index = 0; index < state.plan.shots.length; index += 1) {
            const option = element("option", "", `Scene ${index + 1} — ${state.plan.shots[index].id || `clip_${String(index + 1).padStart(4, "0")}`}`);
            option.value = String(index);
            sceneSelect.append(option);
        }
        sceneSelect.value = String(state.active);
        sceneSelect.title = "Jump directly to another scene prompt.";
        sceneSelect.addEventListener("change", () => navigate(0, sceneSelect.value));

        const font = element("div", "h3sp-font");
        const fontValue = element("span", "h3sp-font-value", `${state.fontSize}px`);
        const smaller = button("A−", "Decrease editor font size", () => {
            state.fontSize = clamp(state.fontSize - 2, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_FONT_SIZE);
            persistView();
            render();
        });
        const larger = button("A+", "Increase editor font size", () => {
            state.fontSize = clamp(state.fontSize + 2, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_FONT_SIZE);
            persistView();
            render();
        });
        smaller.disabled = state.fontSize <= MIN_FONT_SIZE;
        larger.disabled = state.fontSize >= MAX_FONT_SIZE;
        font.append(smaller, fontValue, larger);
        nav.append(previous, sceneSelect, next, add, font);

        const textarea = element("textarea", "h3sp-textarea");
        textarea.value = promptValueToText(shot.prompt, `Scene ${state.active + 1} prompt`);
        textarea.placeholder = "Write this scene's action, camera, performance, dialogue, and ending continuity…";
        textarea.spellcheck = true;
        textarea.title = "This is the actual active scene prompt in the connected H3 Chain Plan.";
        textarea.classList.toggle("h3sp-hidden", state.decorated);
        state.promptTextarea = textarea;
        state.promptUndo = promptUndoForScene(shotId, textarea.value);

        const {records} = availableReferenceRecords(
            node, state.active + 1, {prompt: [
                sharedPrompt(state.plan).text.trim(), textarea.value.trim(),
            ].filter(Boolean).join("\n\n")});
        state.records = records;
        const editorShell = element("div", "h3sp-editor-shell");
        editorShell.classList.toggle("h3sp-hidden", !state.decorated);
        const richEditor = element("div", "h3sp-rich-editor");
        richEditor.contentEditable = "true";
        richEditor.spellcheck = true;
        richEditor.tabIndex = 0;
        richEditor.setAttribute("role", "textbox");
        richEditor.setAttribute("aria-multiline", "true");
        richEditor.dataset.placeholder = textarea.placeholder;
        richEditor.title = textarea.title;
        state.richEditor = richEditor;
        renderRichEditorText(textarea.value);
        editorShell.append(richEditor);

        const tools = element("div", "h3sp-tools");
        const refs = element("div", "h3sp-refs");
        const referenceButton = button("@ Reference", "Open connected Ref2VA references and previews (@)", () => {
            const opening = !refs.classList.contains("h3sp-open");
            if (opening) renderReferenceTray(refs);
            refs.classList.toggle("h3sp-open", opening);
        });
        const dialogueButton = button("# Dialogue", "Wrap selection in <d> dialogue tags (#)", () => {
            insertPromptDialogue();
        });
        const presentationButton = button(
            state.decorated ? "Rich text" : "Plain text",
            state.decorated
                ? "Show the same prompt as plain text"
                : "Color recognized H3 references, subjects, and dialogue tags",
            () => {
                if (state.decorated && state.richEditor) {
                    textarea.value = editorPlainText(state.richEditor);
                }
                state.decorated = !state.decorated;
                persistView();
                render();
                (state.decorated ? state.richEditor : state.promptTextarea)?.focus();
            },
        );
        presentationButton.classList.toggle("h3sp-presentation-active", state.decorated);
        tools.append(
            referenceButton,
            dialogueButton,
            presentationButton,
            element("span", "h3sp-hint", "Alt+←/→ scenes · @ refs · # dialogue"),
        );
        const footer = element("div", "h3sp-footer");
        const identity = element(
            "span", "", `Scene ${state.active + 1}/${state.plan.shots.length} · ${shotId}`,
        );
        const status = element("span", "h3sp-footer-status", "Synchronized with Plan");
        const historyHost = element("div", "h3sp-history");
        footer.append(identity, historyHost, status);
        state.history.host = historyHost;
        state.history.textarea = textarea;
        state.history.status = status;

        const applyPromptUndo = (direction, target) => {
            const text = state.promptUndo?.[direction]?.();
            if (text == null) return false;
            const richCaret = target === richEditor
                ? selectionTextOffset(richEditor) : null;
            textarea.value = text;
            shot.prompt = promptTextToLines(text);
            writePlan(status);
            scheduleHistoryDraft(shotId, text);
            renderRichEditorText(
                text,
                richCaret == null ? null : Math.min(richCaret, text.length),
            );
            if (target === textarea) textarea.setSelectionRange(text.length, text.length);
            target.focus();
            refreshAssistant();
            return true;
        };
        const handlePromptUndo = (event, target) => {
            const direction = promptUndoDirection(event);
            if (!direction) return false;
            event.preventDefault();
            applyPromptUndo(direction, target);
            return true;
        };

        textarea.addEventListener("input", (event) => {
            state.promptUndo?.record(textarea.value, {
                inputType:event.inputType || state.richInputType,
            });
            shot.prompt = promptTextToLines(textarea.value);
            writePlan(status);
            scheduleHistoryDraft(shotId, textarea.value);
            if (document.activeElement !== richEditor) renderRichEditorText(textarea.value);
            refreshAssistant();
        });
        textarea.addEventListener("keydown", (event) => {
            if (handlePromptUndo(event, textarea)) {
                return;
            } else if (event.altKey && event.key === "ArrowLeft") {
                event.preventDefault();
                navigate(-1);
            } else if (event.altKey && event.key === "ArrowRight") {
                event.preventDefault();
                navigate(1);
            } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === "@") {
                event.preventDefault();
                renderReferenceTray(refs);
                refs.classList.add("h3sp-open");
                refs.querySelector(".h3sp-ref-chip, button")?.focus();
            } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === "#") {
                event.preventDefault();
                insertPromptDialogue();
            }
        });

        richEditor.addEventListener("input", (event) => {
            state.richInputType = event.inputType || "";
            try {
                textarea.value = editorPlainText(richEditor);
                textarea.dispatchEvent(new Event("input", {bubbles: true}));
            } finally {
                state.richInputType = "";
            }
        });
        richEditor.addEventListener("beforeinput", (event) => {
            if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
                event.preventDefault();
                insertPlainText(richEditor, "\n");
            }
        });
        richEditor.addEventListener("paste", (event) => {
            event.preventDefault();
            insertPlainText(richEditor, event.clipboardData?.getData("text/plain") ?? "");
        });
        richEditor.addEventListener("copy", (event) => copyEditorSelection(richEditor, event));
        richEditor.addEventListener("cut", (event) => copyEditorSelection(richEditor, event, true));
        richEditor.addEventListener("keydown", (event) => {
            if (handlePromptUndo(event, richEditor)) {
                return;
            } else if (event.altKey && event.key === "ArrowLeft") {
                event.preventDefault();
                navigate(-1);
            } else if (event.altKey && event.key === "ArrowRight") {
                event.preventDefault();
                navigate(1);
            } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === "@") {
                event.preventDefault();
                renderReferenceTray(refs);
                refs.classList.add("h3sp-open");
            } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === "#") {
                event.preventDefault();
                insertPromptDialogue();
            } else if (event.key === "Escape") {
                refs.classList.remove("h3sp-open");
            }
        });
        richEditor.addEventListener("blur", () => {
            renderRichEditorText(editorPlainText(richEditor));
        });

        root.append(head, nav, tools, refs, textarea, editorShell);
        if (PROMPT_ASSISTANT_ENABLED) {
            const assistantHost = element("div", "h3sp-assist");
            assistant.host = assistantHost;
            renderAssistant(assistantHost, textarea);
            root.append(assistantHost);
        }
        root.append(footer);
        void loadHistory(shotId, textarea.value);
    }

    function loadPlan(force = false) {
        const planNode = upstreamPlanNode(node);
        const planWidget = planNode?.widgets?.find((item) => item.name === "plan_json");
        if (!planNode || !planWidget) {
            if (force || state.planNode) {
                state.plan = null;
                state.planNode = null;
                state.planWidget = null;
                state.lastValue = "";
                state.lastRunName = "";
                showFailure("No connected H3 Chain Plan was found.");
            }
            return;
        }
        const value = String(planWidget.value ?? "");
        const runName = String(planNode.widgets?.find(
            (item) => item.name === "run_name",
        )?.value ?? "").trim();
        if (!force && planNode === state.planNode && value === state.lastValue
            && runName === state.lastRunName) return;
        try {
            state.plan = parsePlanJson(value);
            state.planNode = planNode;
            state.planWidget = planWidget;
            state.lastValue = value;
            state.lastRunName = runName;
            render();
        } catch (error) {
            showFailure(`Connected Plan JSON is invalid:\n${error.message}`);
        }
    }

    const widget = node.addDOMWidget(
        "h3_scene_prompt_editor", "h3-scene-prompt-editor", root,
        {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => PROMPT_ASSISTANT_ENABLED ? 760 : 420,
        },
    );
    widget.serialize = false;
    const minimumWidth = PROMPT_ASSISTANT_ENABLED ? 760 : 700;
    const minimumHeight = PROMPT_ASSISTANT_ENABLED ? 900 : 620;
    const currentWidth = Number(node.size?.[0]);
    const currentHeight = Number(node.size?.[1]);
    // Undo only the exact assistant-era default dimensions. Preserve any node
    // the user deliberately made larger.
    const targetWidth = !PROMPT_ASSISTANT_ENABLED && currentWidth === 760
        ? minimumWidth : Math.max(currentWidth || minimumWidth, minimumWidth);
    const targetHeight = !PROMPT_ASSISTANT_ENABLED && currentHeight === 900
        ? minimumHeight : Math.max(currentHeight || minimumHeight, minimumHeight);
    node.setSize?.([
        targetWidth,
        targetHeight,
    ]);

    const connectionsChanged = node.onConnectionsChange;
    node.onConnectionsChange = function () {
        const result = connectionsChanged?.apply(this, arguments);
        setTimeout(() => loadPlan(true), 0);
        return result;
    };
    const onPromptExecuted = (event) => {
        const values = event.detail?.output?.h3_chain_active_scene;
        const scene = Array.isArray(values) ? values.at(-1) : null;
        if (!scene || String(scene.run_name ?? "") !== planRunName()) return;
        const shot = state.plan?.shots?.[state.active];
        const shotId = String(shot?.id ?? "");
        if (!shotId || String(scene.shot_id ?? "") !== shotId) return;
        // Current Shot marks the revision on the backend before emitting this
        // event. Reload only the lightweight index; prompt content stays lazy.
        window.setTimeout(() => {
            if (state.history.sceneKey === historySceneKey(planRunName(), shotId)) {
                void loadHistory(shotId, promptValueToText(shot.prompt), false);
            }
        }, 50);
    };
    api.addEventListener("executed", onPromptExecuted);

    const removed = node.onRemoved;
    node.onRemoved = function () {
        if (state.pollTimer != null) window.clearInterval(state.pollTimer);
        if (state.popoverTimer != null) window.clearTimeout(state.popoverTimer);
        hidePopover();
        state.popover?.remove();
        api.removeEventListener("executed", onPromptExecuted);
        delete node._h3PromptCompanionSetActiveScene;
        delete node._h3PromptCompanionSetScenePrompt;
        void flushHistoryDraft();
        if (PROMPT_ASSISTANT_ENABLED) {
            assistant.preparingRequest = null;
            clearAssistantReconnect();
            clearPendingRequest();
            assistant.client?.close();
        }
        return removed?.apply(this, arguments);
    };
    node._h3PromptCompanionSetActiveScene = (planNode, index) => {
        if (planNode !== state.planNode || !state.plan?.shots?.length) return false;
        navigate(0, index, {synchronize:false, focus:false});
        return true;
    };
    node._h3PromptCompanionSetScenePrompt = (planNode, index, text) => {
        if (planNode !== state.planNode || !state.plan?.shots?.[index]) return false;
        state.plan.shots[index].prompt = promptTextToLines(text);
        const shotId = String(
            state.plan.shots[index].id
            || `clip_${String(index + 1).padStart(4, "0")}`,
        );
        const promptUndo = promptUndoForScene(shotId, text, {external:true});
        if (index === state.active) state.promptUndo = promptUndo;
        if (index === state.active) {
            const textarea = root.querySelector(".h3sp-textarea");
            if (textarea && textarea.value !== text) {
                const focused = document.activeElement === textarea;
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const richFocused = document.activeElement === state.richEditor;
                const richCaret = richFocused ? selectionTextOffset(state.richEditor) : null;
                textarea.value = text;
                if (focused) textarea.setSelectionRange(
                    Math.min(start, text.length), Math.min(end, text.length));
                renderRichEditorText(
                    text,
                    richCaret == null ? null : Math.min(richCaret, text.length),
                );
                scheduleHistoryDraft(
                    String(state.plan.shots[index].id || `clip_${String(index + 1).padStart(4, "0")}`),
                    text);
                refreshAssistant();
            }
        }
        state.lastValue = String(state.planWidget?.value ?? state.lastValue);
        return true;
    };
    node._h3ScenePromptEditorRefresh = () => loadPlan(true);
    state.pollTimer = window.setInterval(() => loadPlan(false), 500);
    loadPlan(true);
    if (PROMPT_ASSISTANT_ENABLED) restorePendingRequest();
}

app.registerExtension({
    name: "minimax_h3_context_loop.scene_prompt_editor",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            setTimeout(() => mount(this), 0);
            return result;
        };
    },
    async nodeCreated(node) {
        if (nodeType(node) === NODE_NAME) mount(node);
    },
    async afterConfigureGraph() {
        for (const node of allNodes(app.graph)) {
            if (nodeType(node) === NODE_NAME) {
                setTimeout(() => node._h3ScenePromptEditorRefresh?.(), 0);
            }
        }
    },
});
