/**
 * experimental/dump-trace.mjs
 *
 * Queries MongoDB for a mission trace and writes a self-contained
 * experimental/report.html for browser-based visualization.
 *
 * Usage:
 *   MISSION_ID=dpo-team-20260614-6572 MONGODB_URI="mongodb+srv://..." node experimental/dump-trace.mjs
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { MongoClient } = await import(
  join(dirname(fileURLToPath(import.meta.url)), "../node_modules/mongodb/lib/index.js")
);

const MISSION_ID = process.env.MISSION_ID;
const MONGODB_URI = process.env.MONGODB_URI;
if (!MISSION_ID || !MONGODB_URI) {
  console.error("MISSION_ID and MONGODB_URI are required");
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db();

console.log(`Querying mission: ${MISSION_ID}`);

// ── Fetch data ───────────────────────────────────────────────────────────────

const [missionDoc, llmCallDocs, mailboxDocs, toolResultDocs] = await Promise.all([
  db.collection("missions").findOne({ missionId: MISSION_ID }),
  db.collection("llmCallLog").find({ missionId: MISSION_ID }).sort({ savedAt: 1 }).toArray(),
  db.collection("mailbox").find({ missionId: MISSION_ID }).sort({ timestamp: 1 }).toArray(),
  // Tool results live in conversationMessages as role="toolResult" messages.
  // We index them by toolCallId so each tool call can look up its output.
  db.collection("conversationMessages")
    .find({ missionId: MISSION_ID, "message.role": "toolResult" })
    .project({ "message.toolCallId": 1, "message.content": 1, "message.isError": 1 })
    .toArray(),
]);

await client.close();

console.log(`  llmCallLog entries : ${llmCallDocs.length}`);
console.log(`  mailbox messages   : ${mailboxDocs.length}`);
console.log(`  tool results       : ${toolResultDocs.length}`);

// Index tool results by toolCallId for O(1) lookup during transform.
const RESULT_TRUNCATE = 3000;
const toolResultByCallId = {};
for (const doc of toolResultDocs) {
  const id = doc.message?.toolCallId;
  if (!id) continue;
  const text = (doc.message?.content ?? []).map(c => c.text ?? "").join("").trimEnd();
  toolResultByCallId[id] = {
    text: text.length > RESULT_TRUNCATE ? text.slice(0, RESULT_TRUNCATE) + `\n… [${text.length - RESULT_TRUNCATE} chars truncated]` : text,
    isError: doc.message?.isError ?? false,
  };
}

// ── Transform ────────────────────────────────────────────────────────────────

const TEXT_TRUNCATE = 4000;
const ARGS_TRUNCATE = 2000;
const FILE_CONTENT_TRUNCATE = 6000;

function truncateText(s, n) {
  return s.length > n ? s.slice(0, n) + `\n… [${s.length - n} chars truncated]` : s;
}

// Skill paths follow the convention: skills/{_platform|_team|mission}/<skill-name>/...
// Agents invoke skills via the generic Bash tool (cat .../SKILL.md, node .../scripts/x.sh),
// so skill identity has to be inferred from path strings in tool call arguments.
const SKILL_PATH_RE = /skills\/(?:_platform|_team|mission)\/([A-Za-z0-9_.-]+)/;

function extractSkillInfo(toolName, argsRaw) {
  const m = argsRaw.match(SKILL_PATH_RE);
  if (!m) return { skill: null, skillAction: null };
  const skill = m[1];
  const tail = argsRaw.slice(m.index);
  const skillAction = /SKILL\.md/i.test(tail)
    ? "read-instructions"
    : toolName === "Bash" && /\/scripts\/|\.(sh|py|js|mjs)\b/i.test(tail)
      ? "exec-script"
      : "access";
  return { skill, skillAction };
}

// Strip the mission's shared-dir prefix so file paths read as short, chart-friendly labels.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const SHARED_PREFIX_RE = new RegExp(`.*missions/${escapeRegExp(MISSION_ID)}/shared/`);
function relPath(p) {
  return p.replace(SHARED_PREFIX_RE, "");
}

// Best-effort filter for regex matches that are real-looking paths, not flag
// remnants or fragments of inline JS/array literals caught by the same regex.
function looksLikePath(s) {
  if (!s || /[()[\]{}'",;]/.test(s)) return false;
  if (/^-?\d+$/.test(s)) return false;
  if (s.startsWith("&") || s === "/dev/null") return false;
  return (
    s.startsWith("/") || s.startsWith("./") || s.startsWith("../") ||
    s.startsWith("~") || s.startsWith("$") || s.includes("/") ||
    /\.[A-Za-z0-9]{1,6}$/.test(s)
  );
}

// Extract env-var → path bindings from a Bash command string.
// Captures uppercase env-var assignments whose value looks like an absolute path,
// e.g. TASKS_DIR=/path/to/tasks or SHARED_DIR=/missions/...
function extractEnvBindings(cmd) {
  const bindings = {};
  for (const m of cmd.matchAll(/\b([A-Z][A-Z0-9_]*)=(\/[^\s]+)/g)) {
    bindings[m[1]] = m[2];
  }
  return bindings;
}

// Infer files written by skill scripts from structured confirmation output.
// Scripts in this mission print headings like:
//   TASK CREATED: TASK-001     → writes {TASKS_DIR}/_register.json
//   TASK UPDATED: TASK-001     → same
//   FORM-SET RESULT: FINST-002 → writes {FORMS_DIR}/FINST-002.xml
//   FORM-SUBMIT COMPLETE: FINST-002 → same
//   FORM LOADED: ... --template → new instance file created (write)
// The path is reconstructed from env-var bindings in the command + the ID in the result.
function extractScriptFileTouches(cmd, result) {
  if (!result) return [];
  const files = [];
  const seen = new Set();
  const add = (path, mode) => {
    path = path.replace(/\/$/, "");
    if (!path || SKILL_PATH_RE.test(path)) return;
    const rel = relPath(path);
    const key = mode + "|" + rel;
    if (seen.has(key)) return;
    seen.add(key);
    files.push({ path, relPath: rel, mode, content: null });
  };

  const env = extractEnvBindings(cmd);
  const tasksDir = env.TASKS_DIR || (env.SHARED_DIR ? env.SHARED_DIR + "/tasks" : null);
  const formsDir = env.FORMS_DIR || (env.SHARED_DIR ? env.SHARED_DIR + "/ropa/forms" : null);

  if (/TASK (?:CREATED|UPDATED|COMPLETED|CLOSED):/i.test(result) && tasksDir) {
    add(tasksDir + "/_register.json", "write");
  }
  for (const m of result.matchAll(/FORM[- ](?:SET RESULT|SUBMIT COMPLETE):\s*(\S+)/gi)) {
    if (formsDir) add(formsDir + "/" + m[1] + ".xml", "write");
  }
  // form-load --template creates a new instance file
  if (/FORM LOADED:/i.test(result) && /--template\b/.test(cmd)) {
    for (const m of result.matchAll(/Instance\s*:\s*(\S+)/gi)) {
      if (formsDir) add(formsDir + "/" + m[1] + ".xml", "write");
    }
  }

  return files;
}

// Bash has no structured file-path argument, so writes/reads are inferred from
// shell syntax: redirection, tee, cp/mv destinations, and cat/head/tail/less sources.
function extractBashFileTouches(cmd) {
  const touches = [];
  const seen = new Set();
  const add = (raw, mode) => {
    const path = raw.replace(/^['"]|['"]$/g, "");
    if (!looksLikePath(path)) return;
    const key = mode + "|" + path;
    if (seen.has(key)) return;
    seen.add(key);
    touches.push({ path, mode });
  };
  for (const m of cmd.matchAll(/(?<![<>\d])>{1,2}\s*([^\s|;&><]+)/g)) add(m[1], "write");
  for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?([^\s|;&]+)/g)) add(m[1], "write");
  for (const m of cmd.matchAll(/\b(?:cp|mv)\s+(?:-\w+\s+)*(\S+)\s+(\S+)/g)) add(m[2], "write");
  for (const m of cmd.matchAll(/\b(?:cat|head|tail|less|more)\s+(?:-\w+\s+)*([^\s|;&><]+)/g)) add(m[1], "read");
  return touches;
}

// Direct writes (WriteFile/EditFile) carry an explicit path; Bash writes/reads are
// inferred from shell syntax. Paths under skills/ are excluded — those are already
// surfaced via the skill tag, and double-counting them would clutter the file filter.
function extractFileTouches(toolName, args, resultEntry) {
  const raw = [];
  if (toolName === "WriteFile" && typeof args.path === "string") {
    raw.push({ path: args.path, mode: "write", content: truncateText(args.content ?? "", FILE_CONTENT_TRUNCATE) });
  } else if (toolName === "EditFile" && typeof args.path === "string") {
    raw.push({
      path: args.path,
      mode: "edit",
      oldString: truncateText(args.old_string ?? "", FILE_CONTENT_TRUNCATE),
      newString: truncateText(args.new_string ?? "", FILE_CONTENT_TRUNCATE),
    });
  } else if (toolName === "Bash" && typeof args.command === "string") {
    const cmd = args.command;
    const touches = extractBashFileTouches(cmd);
    const readCount = touches.filter(t => t.mode === "read").length;
    for (const t of touches) {
      const content = t.mode === "read" && readCount === 1 ? (resultEntry?.text ?? null) : null;
      raw.push({ path: t.path, mode: t.mode, content });
    }
    // Infer files written by skill scripts from their structured result output
    if (resultEntry && !resultEntry.isError) {
      raw.push(...extractScriptFileTouches(cmd, resultEntry.text ?? ""));
    }
  }
  return raw
    .filter(f => !SKILL_PATH_RE.test(f.path))
    .map(f => ({ ...f, relPath: relPath(f.path) }));
}

function dedupeFiles(files) {
  const seen = new Set();
  const out = [];
  for (const f of files) {
    const key = f.mode + "|" + f.relPath;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ relPath: f.relPath, mode: f.mode });
  }
  return out;
}

const llmCalls = llmCallDocs.map(e => {
  const content = e.output?.message?.content ?? [];

  // Text blocks — what the model wrote as prose (not tool calls or thinking).
  const textParts = content
    .filter(c => c.type === "text" && c.text?.trim())
    .map(c => c.text.trimEnd());
  const textOutput = textParts.join("\n\n");

  // Thinking blocks — may be present or redacted.
  const thinkingBlocks = content.filter(
    c => c.type === "thinking" || c.type === "redacted_thinking"
  );

  // Tool calls with their arguments and matched results.
  const toolCalls = content
    .filter(c => c.type === "toolCall")
    .map(c => {
      const argsRaw = JSON.stringify(c.arguments ?? {}, null, 2);
      const argsStr = argsRaw.length > ARGS_TRUNCATE
        ? argsRaw.slice(0, ARGS_TRUNCATE) + `\n… [${argsRaw.length - ARGS_TRUNCATE} chars truncated]`
        : argsRaw;
      const resultEntry = toolResultByCallId[c.id] ?? null;
      const { skill, skillAction } = extractSkillInfo(c.name, argsRaw);
      const files = extractFileTouches(c.name, c.arguments ?? {}, resultEntry);
      return {
        id: c.id,
        name: c.name,
        argsStr,
        result: resultEntry?.text ?? null,
        isError: resultEntry?.isError ?? false,
        skill,
        skillAction,
        files,
      };
    });

  return {
    agentId: e.agentId,
    turnNumber: e.turnNumber,
    isReflection: e.isReflection ?? false,
    savedAt: e.savedAt?.toISOString?.() ?? e.savedAt,
    model: e.model ?? "",
    inputTokens: e.usage?.inputTokens ?? 0,
    outputTokens: e.usage?.outputTokens ?? 0,
    cacheReadTokens: e.usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: e.usage?.cacheWriteTokens ?? 0,
    costUsd: e.usage?.cost?.totalCostUsd ?? 0,
    stopReason: e.output?.stopReason ?? "",
    // Keep toolsUsed (names only) for chart tooltip; full detail in toolCalls.
    toolsUsed: toolCalls.map(t => t.name),
    toolCount: toolCalls.length,
    hasError: toolCalls.some(t => t.isError),
    skillsUsed: [...new Set(toolCalls.filter(t => t.skill).map(t => t.skill))],
    filesTouched: dedupeFiles(toolCalls.flatMap(t => t.files)),
    textOutput: textOutput.length > TEXT_TRUNCATE
      ? textOutput.slice(0, TEXT_TRUNCATE) + `\n… [${textOutput.length - TEXT_TRUNCATE} chars truncated]`
      : textOutput,
    hasThinking: thinkingBlocks.length > 0,
    thinkingSummary: thinkingBlocks
      .map(b => b.thinking ? b.thinking.slice(0, 300) : "[redacted thinking block]")
      .join("\n"),
    toolCalls,
  };
});
// toolCount already set in the map above; no need for a second pass.

const messages = mailboxDocs.map(m => ({
  from: m.from ?? "",
  to: Array.isArray(m.to) ? m.to : [m.to],
  subject: m.subject ?? "",
  bodyPreview: (m.body ?? "").slice(0, 400),
  timestamp: m.timestamp?.toISOString?.() ?? m.timestamp,
}));

// ── Summary ──────────────────────────────────────────────────────────────────

const agentIds = [...new Set(llmCalls.map(c => c.agentId))].sort();
const startTime = llmCalls.at(0)?.savedAt ?? null;
const endTime   = llmCalls.at(-1)?.savedAt ?? null;
const durationHours = startTime && endTime
  ? (new Date(endTime) - new Date(startTime)) / 3_600_000 : 0;
const totalCostUsd   = llmCalls.reduce((s, c) => s + c.costUsd, 0);
const totalToolCalls = llmCalls.reduce((s, c) => s + c.toolCount, 0);
const wakeupsByAgent = {};
for (const c of llmCalls) {
  if (!wakeupsByAgent[c.agentId]) wakeupsByAgent[c.agentId] = new Set();
  wakeupsByAgent[c.agentId].add(c.turnNumber);
}
const totalWakeups = Object.values(wakeupsByAgent).reduce((s, s2) => s + s2.size, 0);

const toolNameSet = new Set();
const skillNameSet = new Set();
for (const c of llmCalls) {
  for (const t of c.toolCalls) {
    toolNameSet.add(t.name);
    if (t.skill) skillNameSet.add(t.skill);
  }
}
const toolNames = [...toolNameSet].sort();
const skillNames = [...skillNameSet].sort();

const fileTagMap = new Map(); // relPath -> Set of modes seen across the mission
for (const c of llmCalls) {
  for (const f of c.filesTouched) {
    if (!fileTagMap.has(f.relPath)) fileTagMap.set(f.relPath, new Set());
    fileTagMap.get(f.relPath).add(f.mode);
  }
}
const filePaths = [...fileTagMap.entries()]
  .map(([relPath, modes]) => ({ relPath, modes: [...modes] }))
  .sort((a, b) => {
    const aw = a.modes.includes("write") || a.modes.includes("edit");
    const bw = b.modes.includes("write") || b.modes.includes("edit");
    if (aw !== bw) return aw ? -1 : 1;
    return a.relPath.localeCompare(b.relPath);
  });

const TRACE = {
  mission: {
    missionId: MISSION_ID,
    name: missionDoc?.name ?? MISSION_ID,
    status: missionDoc?.status ?? "unknown",
    createdAt: missionDoc?.createdAt?.toISOString?.() ?? null,
  },
  summary: {
    startTime, endTime,
    durationHours: +durationHours.toFixed(2),
    agentIds, totalWakeups,
    totalLlmCalls: llmCalls.length,
    totalToolCalls, totalMessages: messages.length,
    totalCostUsd: +totalCostUsd.toFixed(4),
    toolNames, skillNames, filePaths,
  },
  llmCalls,
  messages,
};

// ── Generate HTML ────────────────────────────────────────────────────────────

const html = buildHtml(TRACE);
const outPath = join(dirname(fileURLToPath(import.meta.url)), "report.html");
writeFileSync(outPath, html, "utf-8");
console.log(`\nReport written to: ${outPath}`);

// ── HTML builder ─────────────────────────────────────────────────────────────

function buildHtml(trace) {
  const dataJson = JSON.stringify(trace);

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>MAGI Trace — ${trace.mission.name}</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: system-ui, sans-serif;
  background: #0f1117;
  color: #d0d8f0;
  font-size: 13px;
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ── Header ── */
#header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 22px;
  padding: 8px 18px;
  background: #171a2b;
  border-bottom: 1px solid #252840;
}
#header h1   { font-size: 14px; font-weight: 600; color: #a0aaff; white-space: nowrap; }
.stat .val   { font-size: 16px; font-weight: 700; color: #fff; }
.stat .lbl   { font-size: 10px; color: #555; margin-top: 1px; }
.spacer      { flex: 1; }
.mid         { color: #333; font-size: 11px; }

/* ── Body layout ── */
#body {
  flex: 1; min-height: 0;
  display: flex; gap: 2px; padding: 2px;
}
#left  { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
#right {
  width: 320px; flex-shrink: 0;
  background: #13161f;
  border: 1px solid #1e2235; border-radius: 6px;
  overflow-y: auto; padding: 12px;
}

/* ── Panels ── */
.panel {
  background: #13161f;
  border: 1px solid #1e2235; border-radius: 6px;
  overflow: hidden; display: flex; flex-direction: column;
}
.panel-title {
  flex-shrink: 0;
  padding: 5px 10px; font-size: 10px; font-weight: 600;
  color: #6070a0; border-bottom: 1px solid #1e2235;
  text-transform: uppercase; letter-spacing: .06em;
  display: flex; align-items: center; gap: 8px;
}
.btns { display: flex; gap: 4px; margin-left: auto; }
.btns button {
  background: #1e2235; border: 1px solid #2d3055; color: #888;
  padding: 1px 8px; border-radius: 3px; cursor: pointer; font-size: 10px;
}
.btns button.active { background: #2a3478; color: #b0c4ff; border-color: #4a5ecc; }

/* ── Filter chips ── */
.filter-row {
  flex-shrink: 0;
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 5px 10px; border-bottom: 1px solid #1e2235;
}
.filter-label {
  color: #445; text-transform: uppercase; letter-spacing: .06em;
  margin-right: 2px; font-size: 9px;
}
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  background: #161a2a; border: 1px solid #262a44; color: #7888b0;
  padding: 2px 8px; border-radius: 10px; cursor: pointer;
  font-size: 10px; user-select: none;
  transition: background .15s, border-color .15s, color .15s;
}
.chip:hover     { border-color: #3a4070; color: #a0b0e0; }
.chip.active     { background: #232a55; border-color: #5570dd; color: #cfe0ff; }
.chip.chip-skill { color: #c0a050; }
.chip.chip-skill.active { background: #3a2f10; border-color: #d4a017; color: #ffd980; }
.chip.clear-chip { color: #445; border-style: dashed; }
.chip.chip-file-write { color: #e0a040; }
.chip.chip-file-write.active { background: #3a2a10; border-color: #e0a040; color: #ffd9a0; }
.chip.chip-file-read { color: #6a90c0; }
.chip.chip-file-read.active { background: #1a2a45; border-color: #4a80cc; color: #bcd6ff; }

/* ═══ Page navigation ═══════════════════════════════════════════════════ */
#page-tabs {
  flex-shrink: 0; display: flex; align-items: flex-end; gap: 2px;
  padding: 0 12px; background: #090b14; border-bottom: 2px solid #161a28;
}
.page-tab {
  padding: 5px 18px; border: 1px solid transparent; border-bottom: none;
  border-radius: 6px 6px 0 0; cursor: pointer; font-size: 11px; font-family: inherit;
  background: transparent; color: #445; position: relative; top: 2px;
}
.page-tab:hover:not(.active) { color: #6677a8; background: #0e1220; }
.page-tab.active { background: #0f1117; border-color: #1e2440; color: #8090c0; }

/* ═══ File Explorer page ════════════════════════════════════════════════ */
#page-files { display: none; flex: 1; min-height: 0; flex-direction: row; background: #0b0d1a; }
#files-sidebar {
  width: 270px; flex-shrink: 0; display: flex; flex-direction: column;
  border-right: 1px solid #161a28; background: #0c0e1c;
}
#files-filter-bar {
  flex-shrink: 0; padding: 8px; border-bottom: 1px solid #161a28;
  display: flex; flex-direction: column; gap: 5px;
}
#files-search {
  width: 100%; background: #090b16; border: 1px solid #1c2038; color: #7888a8;
  padding: 4px 8px; border-radius: 6px; font-size: 10px; font-family: inherit; outline: none;
}
#files-search:focus { border-color: #2e3870; }
#files-search::placeholder { color: #2a3050; }
.files-chip-row { display: flex; gap: 3px; flex-wrap: wrap; align-items: center; }
.files-chip-lbl { font-size: 9px; color: #334; text-transform: uppercase; letter-spacing: .07em; margin-right: 2px; }
#file-tree-container { flex: 1; overflow-y: auto; padding: 4px 0; }
#files-tree-count { font-size: 9px; color: #334; padding: 2px 8px 4px; }

.tree-dir-label {
  display: flex; align-items: center; gap: 3px; cursor: pointer;
  font-size: 10px; color: #3d4a70; user-select: none; white-space: nowrap;
}
.tree-dir-label:hover { color: #6677aa; }
.tree-arrow { width: 12px; text-align: center; font-size: 8px; flex-shrink: 0; }
.tree-dir-children { display: block; }
.tree-dir-children.tree-collapsed { display: none; }
.tree-file-item {
  display: flex; align-items: center; gap: 3px; padding: 2px 0;
  cursor: pointer; font-size: 10px; color: #5566a0; white-space: nowrap; overflow: hidden;
}
.tree-file-item:hover { color: #8899cc; background: #0e1225; }
.tree-file-item.fe-selected { background: #121a38; color: #ccddff; }
.tree-file-item.has-write { color: #b08530; }
.tree-file-item.has-write.fe-selected { background: #1f1500; color: #ffcc60; }
.tree-agent-dots { display: flex; gap: 2px; flex-shrink: 0; margin-left: auto; padding-right: 6px; }
.tree-agent-dot { width: 5px; height: 5px; border-radius: 50%; }

#files-main-area { flex: 1; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid #161a28; }
#files-content-header {
  flex-shrink: 0; padding: 7px 12px 5px; border-bottom: 1px solid #161a28;
}
#files-content-path { font-size: 11px; font-weight: 600; color: #8090b8; word-break: break-all; }
#files-touch-selector { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; min-height: 18px; }
.touch-chip {
  font-size: 9px; padding: 1px 7px; border-radius: 8px; border: 1px solid #1e2438;
  background: #0d1022; color: #445; cursor: pointer; white-space: nowrap;
}
.touch-chip:hover { border-color: #384078; color: #6677aa; }
.touch-chip.tc-active { border-color: #4466aa; background: #141c38; color: #8aaace; }
#files-content-body {
  flex: 1; overflow-y: auto; padding: 10px 14px;
  font-family: 'SF Mono', Consolas, 'Courier New', monospace;
  font-size: 11px; line-height: 1.6; color: #78a890; white-space: pre-wrap; word-break: break-all;
}
#files-content-body.fe-plain { font-family: inherit; color: #445; font-style: italic; white-space: normal; }
.diff-del { display: block; color: #bb5555; background: #1a0808; padding: 0 4px; margin: 1px 0; white-space: pre-wrap; word-break: break-all; }
.diff-add { display: block; color: #44aa66; background: #081a0e; padding: 0 4px; margin: 1px 0; white-space: pre-wrap; word-break: break-all; }

#files-provenance-panel { width: 210px; flex-shrink: 0; display: flex; flex-direction: column; }
#files-provenance-header {
  flex-shrink: 0; padding: 8px 10px; border-bottom: 1px solid #161a28;
  font-size: 9px; color: #334; text-transform: uppercase; letter-spacing: .08em;
}
#files-provenance-body { flex: 1; overflow-y: auto; padding: 6px 8px; }
.prov-section { margin-bottom: 10px; }
.prov-agent-row { display: flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 600; padding: 2px 0; margin-bottom: 2px; }
.prov-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.prov-touch-item { font-size: 9px; color: #445; padding: 1px 12px; display: flex; gap: 5px; align-items: center; }
.prov-mode { font-size: 8px; padding: 0 4px; border-radius: 3px; background: #101420; }
.prov-mode.pm-write { color: #c09040; }
.prov-mode.pm-edit  { color: #5588cc; }
.prov-mode.pm-read  { color: #3a4460; }
.prov-tl-bar { height: 10px; background: #090b16; border-radius: 3px; position: relative; overflow: hidden; margin: 8px 0 2px; }
.prov-tl-tick { position: absolute; top: 1px; width: 3px; height: 8px; border-radius: 1px; transform: translateX(-50%); }
.prov-touch-detail {
  display: none; padding: 6px 8px 6px 12px; margin: 2px 0 4px;
  border-left: 2px solid #1e2438; background: #090c1a; border-radius: 0 4px 4px 0;
}
.prov-touch-detail.open { display: block; }
.prov-detail-section { margin-bottom: 6px; }
.prov-detail-label { font-size: 8px; color: #334; text-transform: uppercase; letter-spacing: .07em; margin-bottom: 2px; }
.prov-detail-text { font-size: 10px; color: #5a7a90; white-space: pre-wrap; word-break: break-word; line-height: 1.5; max-height: 140px; overflow-y: auto; }
.prov-detail-thinking { font-size: 10px; color: #5566aa; white-space: pre-wrap; word-break: break-word; line-height: 1.5; max-height: 100px; overflow-y: auto; font-style: italic; }
.prov-detail-code { font-size: 9px; color: #7aaa90; background: #060810; padding: 4px 6px; border-radius: 3px; white-space: pre-wrap; word-break: break-all; max-height: 120px; overflow-y: auto; font-family: 'SF Mono', Consolas, monospace; }
.prov-detail-err { font-size: 9px; color: #aa5555; background: #140808; padding: 4px 6px; border-radius: 3px; white-space: pre-wrap; word-break: break-all; max-height: 80px; overflow-y: auto; font-family: 'SF Mono', Consolas, monospace; }
.prov-expand-btn { font-size: 8px; color: #334; cursor: pointer; padding: 1px 5px; border-radius: 4px; border: 1px solid #1a1e30; background: transparent; margin-left: auto; }
.prov-expand-btn:hover { color: #6677aa; border-color: #2a3050; }

/* Markdown rendering in content panel */
#files-content-body.fe-md { color: #a8b8d0; white-space: normal; font-family: inherit; }
#files-content-body.fe-md h1,#files-content-body.fe-md h2,#files-content-body.fe-md h3 { color: #c0d0f0; margin: 12px 0 6px; font-weight: 600; border-bottom: 1px solid #1a2030; padding-bottom: 4px; }
#files-content-body.fe-md h1 { font-size: 15px; } #files-content-body.fe-md h2 { font-size: 13px; } #files-content-body.fe-md h3 { font-size: 12px; }
#files-content-body.fe-md p { margin: 6px 0; line-height: 1.6; }
#files-content-body.fe-md ul,#files-content-body.fe-md ol { margin: 4px 0 4px 18px; }
#files-content-body.fe-md li { margin: 2px 0; line-height: 1.5; }
#files-content-body.fe-md code { background: #0c0e1a; color: #7aaa90; padding: 1px 5px; border-radius: 3px; font-family: 'SF Mono',Consolas,monospace; font-size: 10px; }
#files-content-body.fe-md pre { background: #080a14; padding: 8px 10px; border-radius: 4px; overflow-x: auto; margin: 6px 0; }
#files-content-body.fe-md pre code { background: none; padding: 0; color: #78a890; font-size: 10px; }
#files-content-body.fe-md blockquote { border-left: 3px solid #2a3454; margin: 6px 0; padding: 2px 10px; color: #5566aa; font-style: italic; }
#files-content-body.fe-md hr { border: none; border-top: 1px solid #1a2030; margin: 10px 0; }
#files-content-body.fe-md a { color: #4a80cc; text-decoration: none; } #files-content-body.fe-md a:hover { text-decoration: underline; }
#files-content-body.fe-md table { border-collapse: collapse; width: 100%; margin: 6px 0; font-size: 10px; }
#files-content-body.fe-md th,#files-content-body.fe-md td { border: 1px solid #1e2438; padding: 4px 8px; text-align: left; }
#files-content-body.fe-md th { background: #101420; color: #8090b0; }
#files-content-body.fe-md strong { color: #c0cce8; } #files-content-body.fe-md em { color: #8899cc; }
/* JSON syntax highlighting */
.json-key { color: #7aadcc; } .json-str { color: #88cc88; } .json-num { color: #ddaa55; }
.json-bool { color: #cc88aa; } .json-null { color: #cc88aa; }
/* XML syntax highlighting */
.xml-tag { color: #5599cc; } .xml-attr { color: #99bbdd; } .xml-val { color: #88cc88; }
.xml-comment { color: #445; font-style: italic; } .xml-text { color: #a0b8a0; }

#burn-panel { flex: 1; min-height: 0; }

/* ── Detail panel ── */
#detail-header {
  display: flex; align-items: center; margin-bottom: 10px; gap: 8px;
}
#detail-title { font-size: 12px; color: #a0aaff; font-weight: 600; flex: 1; }
#btn-collapse {
  background: #1e2235; border: 1px solid #2d3055; color: #666;
  padding: 1px 7px; border-radius: 3px; cursor: pointer; font-size: 10px;
  white-space: nowrap;
}
#detail-empty { color: #333; font-style: italic; text-align: center; margin-top: 60px; line-height: 2; }
.dr  { margin-bottom: 7px; }
.dl  { font-size: 10px; color: #6070a0; display: block; margin-bottom: 1px; }
.dv  { color: #d0d8f0; }
.tok-bar { display: flex; height: 5px; border-radius: 3px; overflow: hidden; margin: 4px 0 2px; }
.tok-legend { font-size: 10px; color: #505870; }

/* text output from LLM */
.llm-text {
  margin: 8px 0; padding: 8px;
  background: #0d101a; border-left: 2px solid #3344aa;
  border-radius: 0 4px 4px 0;
  font-size: 11px; line-height: 1.65; color: #b8c8e8;
  white-space: pre-wrap; word-break: break-word;
  max-height: 280px; overflow-y: auto;
}

/* thinking block */
details.thinking-block { margin: 6px 0; }
details.thinking-block > summary {
  font-size: 10px; color: #5566aa; cursor: pointer;
  user-select: none; padding: 3px 0;
}
.thinking-text {
  padding: 6px 8px; background: #0a0c18;
  border-left: 2px solid #334; border-radius: 0 3px 3px 0;
  font-size: 10px; line-height: 1.6; color: #7080a8;
  white-space: pre-wrap; word-break: break-word;
  max-height: 200px; overflow-y: auto; margin-top: 4px;
}

/* tool call accordion */
.tool-block { margin: 6px 0; border: 1px solid #1e2a44; border-radius: 5px; overflow: hidden; }
.tool-header {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; background: #111828; cursor: pointer;
  user-select: none;
}
.tool-name  { font-size: 11px; font-weight: 600; color: #80a8ff; }
.tool-error { font-size: 10px; color: #ff6666; margin-left: auto; }
.tool-ok    { font-size: 10px; color: #44aa66; margin-left: auto; }
details.tool-block > summary { list-style: none; }
details.tool-block > summary::-webkit-details-marker { display: none; }
.tool-section-label {
  font-size: 9px; font-weight: 600; letter-spacing: .08em;
  color: #445; text-transform: uppercase; padding: 4px 8px 2px;
}
.tool-code {
  padding: 6px 8px; background: #0a0c18;
  font-family: 'SF Mono', Consolas, monospace; font-size: 10px;
  line-height: 1.55; color: #8898cc;
  white-space: pre-wrap; word-break: break-all;
  max-height: 240px; overflow-y: auto;
  border-top: 1px solid #1a2030;
}
.tool-result { color: #7aaa7a; }
.tool-result-err { color: #cc7070; }
.skill-badge {
  font-size: 9px; color: #d4a017; background: #2a2410;
  padding: 1px 6px; border-radius: 8px;
}
.file-content {
  padding: 6px 8px; background: #0a0c18;
  font-family: 'SF Mono', Consolas, monospace; font-size: 10px;
  line-height: 1.55; color: #8ccc9a;
  white-space: pre-wrap; word-break: break-all;
  max-height: 260px; overflow-y: auto;
  border-top: 1px solid #1a2030;
}
.file-diff-old { color: #cc8888; }
.file-diff-new { color: #88cc88; }

/* message preview */
.preview {
  margin-top: 8px; color: #9090b0; font-size: 11px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
  max-height: 280px; overflow-y: auto;
  border-top: 1px solid #1e2235; padding-top: 8px;
}

/* nav hint */
.nav-hint {
  margin-top: 10px; font-size: 10px; color: #2d3055;
  text-align: center;
}

/* ── Tooltip ── */
#tooltip {
  position: fixed; background: #1a1d30;
  border: 1px solid #3040aa; border-radius: 5px;
  padding: 8px 10px; font-size: 11px; line-height: 1.6;
  pointer-events: none; display: none; max-width: 300px;
  z-index: 999; color: #c8d0f0;
}
#tooltip b { color: #fff; }

/* ── Brush ── */
.selection { fill: #2a3888; fill-opacity: .45; stroke: #4a5ecc; stroke-width: 1; }
.handle--e, .handle--w { fill: #4a5ecc; }

</style>
</head>
<body>

<div id="header">
  <h1>⬡ ${trace.mission.name}</h1>
  <div class="stat"><div class="val">${trace.summary.durationHours.toFixed(1)}h</div><div class="lbl">Duration</div></div>
  <div class="stat"><div class="val">$${trace.summary.totalCostUsd.toFixed(2)}</div><div class="lbl">Cost</div></div>
  <div class="stat"><div class="val">${trace.summary.totalLlmCalls}</div><div class="lbl">LLM calls</div></div>
  <div class="stat"><div class="val">${trace.summary.totalWakeups}</div><div class="lbl">Wakeups</div></div>
  <div class="stat"><div class="val">${trace.summary.totalToolCalls}</div><div class="lbl">Tool calls</div></div>
  <div class="stat"><div class="val">${trace.summary.totalMessages}</div><div class="lbl">Messages</div></div>
  <div class="stat"><div class="val">${trace.summary.agentIds.length}</div><div class="lbl">Agents</div></div>
  <div class="spacer"></div>
  <div class="mid">${trace.mission.missionId}</div>
</div>

<div id="page-tabs">
  <button class="page-tab active" data-page="timeline" onclick="showPage('timeline')">⬡ Timeline</button>
  <button class="page-tab" data-page="files" onclick="showPage('files')">📁 File Explorer</button>
</div>

<div id="body">
  <div id="left">
    <div class="panel" id="burn-panel">
      <div class="panel-title">
        Cumulative Cost / Tokens &nbsp;—&nbsp;
        <span style="color:#3a4060;font-weight:400">
          brush to zoom &nbsp;·&nbsp; click to inspect &nbsp;·&nbsp; ←→ keys to navigate &nbsp;·&nbsp; click chips below to highlight
        </span>
        <div class="btns">
          <button id="btn-cost"   class="active" onclick="setBurnMode('cost')">Cost $</button>
          <button id="btn-input"  onclick="setBurnMode('input')">Cumul. context</button>
          <button id="btn-ctx"    onclick="setBurnMode('ctx')">Context size</button>
          <button id="btn-output" onclick="setBurnMode('output')">Output tokens</button>
        </div>
      </div>
      <div class="filter-row" id="kind-filter"></div>
      <div class="filter-row" id="tag-filter"></div>
      <div id="filter-status-row" style="flex-shrink:0;display:flex;align-items:center;gap:6px;padding:2px 10px 4px;min-height:18px;"></div>
      <svg id="burn-svg" width="100%" style="flex:1;min-height:0;display:block"></svg>
    </div>
  </div>
  <div id="right">
    <div id="detail-header">
      <div id="detail-title">Detail</div>
      <button id="btn-collapse" onclick="toggleAllDetails()">collapse all</button>
    </div>
    <div id="detail-body">
      <div id="detail-empty">Click a symbol (LLM call)<br>or an arrow (message)<br>for full detail here.<br><br>← → keys navigate<br>within the same agent.</div>
    </div>
  </div>
</div>

<div id="page-files">
  <div id="files-sidebar">
    <div id="files-filter-bar">
      <input id="files-search" type="search" placeholder="search files…">
      <div class="files-chip-row">
        <span class="files-chip-lbl">Agent</span>
        <span id="fe-agent-all" class="chip tc-active" style="font-size:9px;padding:1px 7px;" onclick="feSetAgent(null)">all</span>
      </div>
      <div class="files-chip-row" id="fe-agent-chips"></div>
      <div class="files-chip-row">
        <span id="fe-writes-only" class="chip chip-file-write active" style="font-size:9px;" onclick="feToggleWrites()">✎ writes only</span>
      </div>
      <div class="files-chip-row" id="fe-type-chips"></div>
    </div>
    <div id="files-tree-count"></div>
    <div id="file-tree-container"></div>
  </div>
  <div id="files-main-area">
    <div id="files-content-header">
      <div id="files-content-path" style="color:#334;font-size:11px;">← select a file</div>
      <div id="files-touch-selector"></div>
    </div>
    <div id="files-content-body" class="fe-plain">Select a file from the tree on the left.</div>
  </div>
  <div id="files-provenance-panel">
    <div id="files-provenance-header">Provenance</div>
    <div id="files-provenance-body"></div>
  </div>
</div>

<div id="tooltip"></div>

<script>
const TRACE = ${dataJson};

// ── Palette ──────────────────────────────────────────────────────────────────
const PALETTE = [
  '#5588ff','#ff8833','#44dd88','#ff44aa','#ffdd33',
  '#aa44ff','#33ddff','#ff5555','#88ff44','#ff99cc'
];
const agentColor = {};
TRACE.summary.agentIds.forEach((a, i) => agentColor[a] = PALETTE[i % PALETTE.length]);

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtK  = n => n >= 1000 ? (n/1000).toFixed(1)+'k' : String(Math.round(n));
const fmtC  = c => '$'+c.toFixed(4);
const fmtDT = iso => {
  const d = new Date(iso);
  return d.toLocaleDateString([],{month:'short',day:'numeric'}) + ' ' +
         d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
};

// ── Index calls by agent ──────────────────────────────────────────────────────
const callsByAgent = {};
for (const c of TRACE.llmCalls) {
  (callsByAgent[c.agentId] = callsByAgent[c.agentId] || []).push(c);
}

// ── Cumulative value at arbitrary time for an agent ───────────────────────────
function cumAt(agentId, tMs, mode) {
  const calls = callsByAgent[agentId] || [];
  if (mode === 'ctx') {
    let last = 0;
    for (const c of calls) {
      if (new Date(c.savedAt).getTime() > tMs) break;
      last = valOf(c, mode);
    }
    return last;
  }
  let s = 0;
  for (const c of calls) {
    if (new Date(c.savedAt).getTime() > tMs) break;
    s += valOf(c, mode);
  }
  return s;
}
function valOf(c, mode) {
  return mode === 'cost'   ? c.costUsd
       : mode === 'input'  ? (c.inputTokens + c.cacheReadTokens)
       : mode === 'ctx'    ? (c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens)
       : c.outputTokens;
}

// ── Mark the first LLM call of each (agent, turnNumber) — the wakeup ─────────
const sessionFirstSet = new Set();
{
  const seen = {};
  for (const c of TRACE.llmCalls) {
    const k = c.agentId + '|' + c.turnNumber;
    if (!seen[k]) { seen[k] = true; sessionFirstSet.add(c); }
  }
}

// ── Unified event list per agent for keyboard navigation ──────────────────────
// Entries: { kind, agentId, timeMs, call?, msg? }
const eventsByAgent = {};
for (const agent of TRACE.summary.agentIds) {
  eventsByAgent[agent] = [];
  for (const c of (callsByAgent[agent] || [])) {
    eventsByAgent[agent].push({
      kind: c.isReflection ? 'reflection' : 'llm',
      agentId: agent,
      timeMs: new Date(c.savedAt).getTime(),
      call: c,
    });
  }
  for (const m of TRACE.messages) {
    if (m.from === 'user' && m.to.includes(agent)) {
      eventsByAgent[agent].push({
        kind: 'user-in', agentId: agent,
        timeMs: new Date(m.timestamp).getTime(), msg: m,
      });
    }
    if (m.from === agent && m.to.includes('user')) {
      eventsByAgent[agent].push({
        kind: 'user-out', agentId: agent,
        timeMs: new Date(m.timestamp).getTime(), msg: m,
      });
    }
  }
  eventsByAgent[agent].sort((a, b) => a.timeMs - b.timeMs);
}

// ── Message arrows (agent-to-agent only) ─────────────────────────────────────
const arrows = [];
for (const msg of TRACE.messages) {
  if (!agentColor[msg.from]) continue;
  for (const to of msg.to) {
    if (!agentColor[to] || to === msg.from) continue;
    const sendMs = new Date(msg.timestamp).getTime();
    const recipCalls = callsByAgent[to] ?? [];
    const wakeup = recipCalls.find(c => new Date(c.savedAt).getTime() > sendMs);
    arrows.push({ msg, from: msg.from, to,
                  sendMs, wakeupMs: wakeup ? new Date(wakeup.savedAt).getTime() : null });
  }
}

// ── Selection state ───────────────────────────────────────────────────────────
// selectedRef is the stable TRACE.llmCalls or TRACE.messages object reference.
let selectedRef   = null;
let selAgentId    = null;

function isSelected(evt) {
  if (!selectedRef) return false;
  return (evt.call && evt.call === selectedRef) ||
         (evt.msg  && evt.msg  === selectedRef);
}

function applySelection() {
  dotsG.selectAll('.event-sym')
    .attr('stroke',       d => isSelected(d) ? '#ffffff' : '#0f1117')
    .attr('stroke-width', d => isSelected(d) ? 2.5 : 0.8);
}

// ── Filter state (multi-select chips highlight matching events) ─────────────
// 'error' is a virtual kind: an erroring call shows as ✕ regardless of
// whether it was a plain llm/reflection call, mirroring the symbol drawn.
let activeKinds = new Set();
let activeTags  = new Set();   // tool names or 'skill:<name>'

function evtFilterKind(evt) {
  if (evt.call?.hasError) return 'error';
  return evt.kind;
}
function evtTags(evt) {
  if (!evt.call) return [];
  const tags = new Set();
  for (const t of evt.call.toolCalls) {
    tags.add(t.name);
    if (t.skill) tags.add('skill:' + t.skill);
  }
  return [...tags];
}
function passesFilters(evt) {
  const kindOk = activeKinds.size === 0 || activeKinds.has(evtFilterKind(evt));
  const tagOk  = activeTags.size  === 0 || evtTags(evt).some(t => activeTags.has(t));
  return kindOk && tagOk;
}
function evtOpacity(evt) {
  const filtersActive = activeKinds.size > 0 || activeTags.size > 0;
  if (!filtersActive) return 0.88;
  return passesFilters(evt) ? 0.95 : 0.12;
}

function buildFilterBar() {
  const kindDefs = [
    { key: 'llm',        sym: '●', color: '#9aa6c8', label: 'LLM call' },
    { key: 'reflection', sym: '◆', color: '#5577cc', label: 'reflection' },
    { key: 'error',      sym: '✕', color: '#ff4444', label: 'tool error' },
    { key: 'user-in',    sym: '▲', color: '#ffee55', label: 'user → agent' },
    { key: 'user-out',   sym: '■', color: '#55ddff', label: 'agent → user' },
  ];
  const kindRow = document.getElementById('kind-filter');
  kindRow.innerHTML = '<span class="filter-label">Event</span>';
  kindDefs.forEach(d => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = \`<span style="color:\${d.color}">\${d.sym}</span> \${d.label}\`;
    chip.onclick = () => {
      if (activeKinds.has(d.key)) activeKinds.delete(d.key); else activeKinds.add(d.key);
      chip.classList.toggle('active');
      redraw();
    };
    kindRow.appendChild(chip);
  });
  const clearKind = document.createElement('span');
  clearKind.className = 'chip clear-chip';
  clearKind.textContent = 'clear';
  clearKind.onclick = () => {
    activeKinds.clear();
    kindRow.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    redraw();
  };
  kindRow.appendChild(clearKind);

  const tagRow = document.getElementById('tag-filter');
  tagRow.innerHTML = '<span class="filter-label">Tool / skill</span>';
  TRACE.summary.toolNames.forEach(name => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = name;
    chip.onclick = () => {
      if (activeTags.has(name)) activeTags.delete(name); else activeTags.add(name);
      chip.classList.toggle('active');
      redraw();
    };
    tagRow.appendChild(chip);
  });
  TRACE.summary.skillNames.forEach(name => {
    const tag = 'skill:' + name;
    const chip = document.createElement('span');
    chip.className = 'chip chip-skill';
    chip.innerHTML = \`⚙ \${esc(name)}\`;
    chip.onclick = () => {
      if (activeTags.has(tag)) activeTags.delete(tag); else activeTags.add(tag);
      chip.classList.toggle('active');
      redraw();
    };
    tagRow.appendChild(chip);
  });
  if (TRACE.summary.toolNames.length || TRACE.summary.skillNames.length) {
    const clearTag = document.createElement('span');
    clearTag.className = 'chip clear-chip';
    clearTag.textContent = 'clear';
    clearTag.onclick = () => {
      activeTags.clear();
      tagRow.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      redraw();
    };
    tagRow.appendChild(clearTag);
  }

}

// ═══════════════════════════════════════════════════════════════════════════════
// BURN CHART
// ═══════════════════════════════════════════════════════════════════════════════

const svg        = document.getElementById('burn-svg');
const tooltip    = document.getElementById('tooltip');
let burnMode     = 'cost';
let currentDomain;

const ML = 58, MR = 14, MT = 10, MB = 4;
const OV_H  = 52;
const OV_AX = 14;
const GAP   = 6;

let svgSel, innerG, axisXG, axisYG, gridG, sessionsG, arrowsG, dotsG, overviewG;
let xFull;

function init() {
  buildFilterBar();
  requestAnimationFrame(build);
}

function build() {
  svgSel = d3.select(svg);
  svgSel.selectAll('*').remove();

  const W  = svg.clientWidth;
  const H  = svg.clientHeight;
  const iW = W - ML - MR;
  const iH = H - MT - MB - OV_H - GAP;

  const t0 = new Date(TRACE.summary.startTime);
  const t1 = new Date(TRACE.summary.endTime);
  currentDomain = [t0, t1];

  xFull = d3.scaleTime().domain([t0, t1]).range([0, iW]);

  svgSel.append('defs').append('clipPath').attr('id','burn-clip')
    .append('rect').attr('width', iW).attr('height', iH + 2);

  innerG = svgSel.append('g').attr('transform',\`translate(\${ML},\${MT})\`);

  gridG     = innerG.append('g');
  sessionsG = innerG.append('g').attr('clip-path','url(#burn-clip)');
  arrowsG   = innerG.append('g').attr('clip-path','url(#burn-clip)');
  dotsG     = innerG.append('g').attr('clip-path','url(#burn-clip)');
  axisYG    = innerG.append('g');
  axisXG    = innerG.append('g').attr('transform',\`translate(0,\${iH})\`);

  overviewG = innerG.append('g').attr('transform',\`translate(0,\${iH + GAP})\`);
  buildOverview(iW, t0, t1);

  // ── Legend: agents + event types ──
  const agents = TRACE.summary.agentIds;
  const legG = innerG.append('g').attr('transform',\`translate(\${iW - 4}, 4)\`);

  agents.forEach((a, i) => {
    legG.append('circle').attr('cx', -80).attr('cy', i*15+5).attr('r', 4)
      .attr('fill', agentColor[a]);
    legG.append('text').attr('x', -72).attr('y', i*15+9)
      .style('fill','#8090b0').style('font-size','10px')
      .text(a.length > 18 ? a.slice(0,16)+'..' : a);
  });
  // Event-type legend now lives in the interactive filter-chip row below the title.

  redraw();
}

// ── Overview ──────────────────────────────────────────────────────────────────
function buildOverview(iW, t0, t1) {
  overviewG.selectAll('*').remove();

  const ovH = OV_H - OV_AX;
  overviewG.append('rect').attr('width', iW).attr('height', ovH)
    .attr('fill','#0a0c14').attr('rx', 2);

  const agents = TRACE.summary.agentIds;
  overviewG.selectAll('rect.ov-call').data(TRACE.llmCalls).join('rect')
    .attr('class','ov-call')
    .attr('x', d => xFull(new Date(d.savedAt)))
    .attr('y', d => (agents.indexOf(d.agentId) / agents.length) * ovH + 1)
    .attr('width', 1.5)
    .attr('height', Math.max(2, ovH / agents.length - 2))
    .attr('fill', d => agentColor[d.agentId])
    .attr('opacity', 0.7);

  overviewG.selectAll('line.ov-msg').data(arrows).join('line')
    .attr('class','ov-msg')
    .attr('x1', d => xFull(new Date(d.sendMs)))
    .attr('x2', d => d.wakeupMs ? xFull(new Date(d.wakeupMs)) : xFull(new Date(d.sendMs)))
    .attr('y1', d => {
      const agents = TRACE.summary.agentIds;
      return (agents.indexOf(d.from) / agents.length) * ovH + ovH/(agents.length*2);
    })
    .attr('y2', d => {
      const agents = TRACE.summary.agentIds;
      return (agents.indexOf(d.to) / agents.length) * ovH + ovH/(agents.length*2);
    })
    .attr('stroke', d => agentColor[d.from])
    .attr('stroke-width', 0.8)
    .attr('stroke-opacity', 0.4);

  overviewG.append('g').attr('transform',\`translate(0,\${ovH})\`)
    .call(d3.axisBottom(xFull).ticks(6).tickSizeOuter(0))
    .call(g => g.select('.domain').remove())
    .call(g => g.selectAll('.tick text').style('fill','#445').style('font-size','9px'));

  const brush = d3.brushX()
    .extent([[0, 0], [iW, ovH]])
    .on('brush end', event => {
      if (!event.selection) return;
      const [x0, x1] = event.selection.map(xFull.invert);
      currentDomain = [x0, x1];
      redraw();
    });
  overviewG.append('g').attr('class','brush').call(brush);
}

// ── Main redraw ───────────────────────────────────────────────────────────────
function redraw() {
  if (!svgSel) return;

  const W  = svg.clientWidth;
  const H  = svg.clientHeight;
  const iW = W - ML - MR;
  const iH = H - MT - MB - OV_H - GAP;

  const xV = d3.scaleTime().domain(currentDomain).range([0, iW]);
  const agents = TRACE.summary.agentIds;

  // ── Build series: cumulative (or raw for 'ctx') value per agent ──────────
  const series = agents.map(agent => {
    let cum = 0;
    return {
      agent,
      pts: (callsByAgent[agent] || []).map(c => {
        cum = burnMode === 'ctx' ? valOf(c, burnMode) : cum + valOf(c, burnMode);
        return { t: new Date(c.savedAt), cum, c };
      }),
    };
  });

  const maxCum = d3.max(series, s => d3.max(s.pts, p => p.cum) || 0) || 1;
  const yV = d3.scaleLinear().domain([0, maxCum]).range([iH, 0]).nice();
  const yFmt = burnMode === 'cost'
    ? v => '$' + (v >= 1 ? v.toFixed(1) : v.toFixed(2))
    : v => v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1000 ? (v/1000).toFixed(0)+'k' : String(Math.round(v));

  // ── Grid ──
  gridG.selectAll('*').remove();
  gridG.selectAll('line').data(yV.ticks(5)).join('line')
    .attr('x1', 0).attr('x2', iW)
    .attr('y1', d => yV(d)).attr('y2', d => yV(d))
    .attr('stroke','#1a1e30');

  // ── Reflection threshold (ctx mode only) ─────────────────────────────────
  if (burnMode === 'ctx') {
    const reflY = yV(120000);
    if (reflY >= 0 && reflY <= iH) {
      gridG.append('line')
        .attr('x1', 0).attr('x2', iW)
        .attr('y1', reflY).attr('y2', reflY)
        .attr('stroke', '#cc3355').attr('stroke-width', 1.2)
        .attr('stroke-dasharray', '5,3').attr('opacity', 0.75);
      gridG.append('text')
        .attr('x', iW - 4).attr('y', reflY - 4)
        .attr('text-anchor', 'end').attr('font-size', 9)
        .attr('fill', '#cc3355').attr('opacity', 0.9)
        .text('reflection threshold (120k)');
    }
  }

  // ── Session background bands (per agent × turn) ───────────────────────────
  sessionsG.selectAll('*').remove();
  for (const { agent, pts } of series) {
    if (!pts.length) continue;
    // Group pts by turnNumber
    const byTurn = d3.group(pts, p => p.c.turnNumber);
    for (const turnPts of byTurn.values()) {
      const t0Ms = turnPts[0].t.getTime();
      const t1Ms = turnPts[turnPts.length - 1].t.getTime();
      const x0 = xV(new Date(t0Ms)) - 5;
      const x1 = xV(new Date(t1Ms)) + 5;
      const yA = yV(burnMode === 'ctx' ? 0 : turnPts[0].cum - valOf(turnPts[0].c, burnMode));
      const yB = yV(turnPts[turnPts.length - 1].cum);
      const rectY = Math.min(yA, yB) - 5;
      const rectH = Math.abs(yA - yB) + 10;
      sessionsG.append('rect')
        .attr('x', x0)
        .attr('y', rectY)
        .attr('width', Math.max(10, x1 - x0))
        .attr('height', Math.max(10, rectH))
        .attr('fill', agentColor[agent])
        .attr('opacity', 0.055)
        .attr('rx', 5);
    }
  }

  // ── Build all events for symbol rendering ────────────────────────────────
  const allEvents = [];

  // LLM call events
  for (const { agent, pts } of series) {
    for (const p of pts) {
      allEvents.push({
        kind:    p.c.isReflection ? 'reflection' : 'llm',
        agentId: agent,
        x:       xV(p.t),
        y:       yV(p.cum),
        isFirst: sessionFirstSet.has(p.c),
        call:    p.c,
        msg:     null,
      });
    }
  }

  // User-in / user-out events
  for (const msg of TRACE.messages) {
    const msgMs = new Date(msg.timestamp).getTime();
    if (msg.from === 'user') {
      for (const to of msg.to) {
        if (!agentColor[to]) continue;
        allEvents.push({
          kind: 'user-in', agentId: to, isFirst: false, call: null, msg,
          x: xV(new Date(msgMs)),
          y: yV(cumAt(to, msgMs, burnMode)),
        });
      }
    }
    if (msg.to.includes('user') && agentColor[msg.from]) {
      allEvents.push({
        kind: 'user-out', agentId: msg.from, isFirst: false, call: null, msg,
        x: xV(new Date(msgMs)),
        y: yV(cumAt(msg.from, msgMs, burnMode)),
      });
    }
  }

  // ── Symbol helpers ────────────────────────────────────────────────────────
  function evtSymType(evt) {
    if (evt.call?.hasError)        return d3.symbolX;
    if (evt.kind === 'reflection') return d3.symbolDiamond;
    if (evt.kind === 'user-in')    return d3.symbolTriangle;
    if (evt.kind === 'user-out')   return d3.symbolSquare;
    return d3.symbolCircle;
  }
  const filtersActive = activeKinds.size > 0 || activeTags.size > 0;
  function evtSize(evt) {
    const base = evt.call?.hasError ? 80
      : (evt.kind === 'user-in' || evt.kind === 'user-out') ? 110
      : evt.kind === 'reflection' ? 70
      : evt.isFirst ? 95 : 48;
    return (filtersActive && passesFilters(evt)) ? base * 2.5 : base;
  }
  function evtColor(evt) {
    if (evt.call?.hasError)        return '#ff4444';
    if (evt.kind === 'reflection') return '#5577cc';
    if (evt.kind === 'user-in')    return '#ffee55';
    if (evt.kind === 'user-out')   return '#55ddff';
    return evt.isFirst
      ? agentColor[evt.agentId]
      : agentColor[evt.agentId] + 'cc';
  }

  const symGen = d3.symbol();

  // ── Render symbols ────────────────────────────────────────────────────────
  dotsG.selectAll('*').remove();
  dotsG.selectAll('.event-sym').data(allEvents).join('path')
    .attr('class', 'event-sym')
    .attr('d',         evt => symGen.type(evtSymType(evt)).size(evtSize(evt))())
    .attr('transform', evt => \`translate(\${evt.x},\${evt.y})\`)
    .attr('fill',        evt => evtColor(evt))
    .attr('stroke',      evt => isSelected(evt) ? '#ffffff' : (filtersActive && passesFilters(evt)) ? '#ffdd44' : '#0f1117')
    .attr('stroke-width',evt => isSelected(evt) ? 2.5 : (filtersActive && passesFilters(evt)) ? 2.0 : 0.8)
    .attr('opacity', evt => evtOpacity(evt))
    .style('cursor','pointer')
    .on('mouseenter', (event, evt) => {
      tooltip.style.display = 'block';
      if (evt.call) {
        const c = evt.call;
        const tools = [...new Set(c.toolsUsed)];
        const errCount = c.toolCalls?.filter(t => t.isError).length ?? 0;
        const errSuffix = errCount > 1 ? 's' : '';
        const errPart = errCount
          ? \` · <span style="color:#ff6666">✕ \${errCount} error\${errSuffix}</span>\`
          : '';
        tooltip.innerHTML =
          \`<b>\${c.agentId}</b> · turn \${c.turnNumber}\${c.isReflection?' · <em>reflect</em>':''}\${evt.isFirst?' · <b style="color:#aaa">wakeup</b>':''}\${errPart}<br>\` +
          \`\${fmtDT(c.savedAt)}<br>\` +
          \`in:\${fmtK(c.inputTokens)} cache:\${fmtK(c.cacheReadTokens)} out:\${fmtK(c.outputTokens)}<br>\` +
          \`cost: \${fmtC(c.costUsd)} · stop: \${c.stopReason||'—'}<br>\` +
          (tools.length ? \`tools: \${tools.slice(0,6).join(', ')}\${tools.length>6?'…':''}\` : '<em>no tools</em>');
      } else if (evt.msg) {
        const m = evt.msg;
        tooltip.innerHTML =
          \`<b>\${evt.kind === 'user-in' ? '▲ user → '+evt.agentId : '■ '+evt.agentId+' → user'}</b><br>\` +
          \`"\${m.subject}"<br>\${fmtDT(m.timestamp)}\`;
      }
    })
    .on('mousemove', event => {
      tooltip.style.left = (event.clientX + 14)+'px';
      tooltip.style.top  = (event.clientY - 10)+'px';
    })
    .on('mouseleave', () => { tooltip.style.display = 'none'; })
    .on('click', (event, evt) => {
      event.stopPropagation();
      selectedRef  = evt.call ?? evt.msg ?? null;
      selAgentId   = evt.agentId;
      applySelection();
      if (evt.call) showLlmDetail(evt.call);
      else if (evt.msg) showMsgEventDetail(evt);
    });

  // ── Message arrows (agent-to-agent) ──────────────────────────────────────
  arrowsG.selectAll('*').remove();

  arrowsG.append('defs').selectAll('marker').data(TRACE.summary.agentIds).join('marker')
    .attr('id', a => \`arr-\${a.replace(/[^a-z0-9]/gi,'-')}\`)
    .attr('viewBox','0 -3 6 6').attr('refX',5).attr('refY',0)
    .attr('markerWidth',4).attr('markerHeight',4).attr('orient','auto')
    .append('path').attr('d','M0,-3L6,0L0,3').attr('fill', a => agentColor[a]);

  arrowsG.selectAll('path.msg-arrow').data(arrows).join('path')
    .attr('class','msg-arrow')
    .attr('d', d => {
      const x1 = xV(new Date(d.sendMs));
      const y1 = yV(cumAt(d.from, d.sendMs, burnMode));
      const x2 = d.wakeupMs ? xV(new Date(d.wakeupMs)) : x1 + 30;
      const y2 = yV(cumAt(d.to, d.wakeupMs ?? d.sendMs, burnMode));
      const mx = (x1 + x2) / 2;
      return \`M\${x1},\${y1} C\${mx},\${y1} \${mx},\${y2} \${x2},\${y2}\`;
    })
    .attr('fill','none')
    .attr('stroke', d => agentColor[d.from])
    .attr('stroke-width', 1.5)
    .attr('stroke-opacity', 0.55)
    .attr('marker-end', d => \`url(#arr-\${d.from.replace(/[^a-z0-9]/gi,'-')})\`)
    .style('cursor','pointer')
    .on('mouseenter', (event, d) => {
      tooltip.style.display = 'block';
      tooltip.innerHTML =
        \`<b>\${d.from}</b> → <b>\${d.to}</b><br>\` +
        \`"\${d.msg.subject}"<br>\` +
        \`sent \${fmtDT(d.msg.timestamp)}\` +
        (d.wakeupMs ? \`<br>wakeup +\${Math.round((d.wakeupMs-d.sendMs)/60000)}min\` : '');
    })
    .on('mousemove', event => {
      tooltip.style.left = (event.clientX + 14)+'px';
      tooltip.style.top  = (event.clientY - 10)+'px';
    })
    .on('mouseleave', () => { tooltip.style.display = 'none'; })
    .on('click', (event, d) => { event.stopPropagation(); showMsgDetail(d); });

  // ── Axes ──
  axisXG.call(
    d3.axisBottom(xV).ticks(8).tickSizeOuter(0)
      .tickFormat(d => {
        const span = currentDomain[1] - currentDomain[0];
        return span < 3_600_000
          ? d3.timeFormat('%H:%M:%S')(d)
          : d3.timeFormat('%H:%M')(d);
      })
  );
  axisXG.selectAll('.tick text').style('fill','#556').style('font-size','10px');
  axisXG.select('.domain').style('stroke','#2a2e45');

  axisYG.call(d3.axisLeft(yV).ticks(5).tickSizeOuter(0).tickFormat(yFmt));
  axisYG.selectAll('.tick text').style('fill','#556').style('font-size','10px');
  axisYG.select('.domain').style('stroke','#2a2e45');

  // ── Filter status row ────────────────────────────────────────────────────────
  const statusRow = document.getElementById('filter-status-row');
  if (statusRow) {
    statusRow.innerHTML = '';
    if (filtersActive) {
      const matchEvts = allEvents.filter(e => passesFilters(e));
      const badge = document.createElement('span');
      badge.style.cssText = 'font-size:10px;color:#88aadd;background:#14182e;border:1px solid #2a3050;padding:1px 8px;border-radius:8px;';
      badge.textContent = matchEvts.length + ' / ' + allEvents.length + ' events match';
      statusRow.appendChild(badge);
      if (matchEvts.length > 0) {
        const matchTimes = matchEvts.filter(e => e.call).map(e => new Date(e.call.savedAt).getTime()).filter(Boolean);
        if (matchTimes.length) {
          const tMin = Math.min(...matchTimes);
          const tMax = Math.max(...matchTimes);
          const zoomBtn = document.createElement('button');
          zoomBtn.textContent = 'zoom to matches';
          zoomBtn.style.cssText = 'margin-left:6px;font-size:10px;background:#1a2040;border:1px solid #3a4060;color:#8899cc;padding:1px 8px;border-radius:8px;cursor:pointer;';
          zoomBtn.onclick = () => {
            const pad = Math.max((tMax - tMin) * 0.5, 90000);
            currentDomain = [new Date(tMin - pad), new Date(tMax + pad)];
            redraw();
          };
          statusRow.appendChild(zoomBtn);
        }
      }
    }
  }
}

// ── Mode toggle ───────────────────────────────────────────────────────────────
function setBurnMode(mode) {
  burnMode = mode;
  ['cost','input','ctx','output'].forEach(m =>
    document.getElementById('btn-'+m).classList.toggle('active', m === mode));
  redraw();
}

// ── Keyboard navigation (←→ within same agent's events) ──────────────────────
document.addEventListener('keydown', e => {
  if (!selectedRef || !selAgentId) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();

  const agentEvts = eventsByAgent[selAgentId] || [];
  let idx = agentEvts.findIndex(ev => (ev.call ?? ev.msg) === selectedRef);
  if (idx < 0) return;

  if (e.key === 'ArrowLeft')  idx = Math.max(0, idx - 1);
  if (e.key === 'ArrowRight') idx = Math.min(agentEvts.length - 1, idx + 1);

  const ev = agentEvts[idx];
  selectedRef = ev.call ?? ev.msg;
  selAgentId  = ev.agentId;

  applySelection();
  if (ev.call) showLlmDetail(ev.call);
  else showMsgEventDetail(ev);
});

// ═══════════════════════════════════════════════════════════════════════════════
// DETAIL PANEL
// ═══════════════════════════════════════════════════════════════════════════════

function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderFileTouch(f) {
  const modeColor = f.mode === 'write' ? '#e0a040' : f.mode === 'edit' ? '#cc88ff' : '#6a90c0';
  let body;
  if (f.mode === 'edit') {
    body = (f.oldString ? \`<div class="file-content file-diff-old">− \${esc(f.oldString)}</div>\` : '') +
           (f.newString ? \`<div class="file-content file-diff-new">+ \${esc(f.newString)}</div>\` : '');
  } else if (f.content) {
    body = \`<div class="file-content">\${esc(f.content)}</div>\`;
  } else {
    body = \`<div style="color:#445;font-size:10px;padding:4px 8px">(content not captured)</div>\`;
  }
  return \`
    <details open style="margin:4px 0 4px 8px">
      <summary style="font-size:10px;cursor:pointer;color:\${modeColor}">\${f.mode} · \${esc(f.relPath)}</summary>
      \${body}
    </details>
  \`;
}

// Toggle all <details> open/collapsed in the detail panel
let allOpen = true;
function toggleAllDetails() {
  allOpen = !allOpen;
  document.querySelectorAll('#detail-body details').forEach(el => {
    el.open = allOpen;
  });
  document.getElementById('btn-collapse').textContent = allOpen ? 'collapse all' : 'expand all';
}

function agentEvtPosition(agentId, ref) {
  const evts = eventsByAgent[agentId] || [];
  const idx = evts.findIndex(ev => (ev.call ?? ev.msg) === ref);
  return idx >= 0 ? \`\${idx + 1} / \${evts.length}\` : '';
}

function showLlmDetail(c) {
  allOpen = true;
  document.getElementById('btn-collapse').textContent = 'collapse all';

  const pos = agentEvtPosition(c.agentId, c);

  let html = \`
    <div class="dr"><span class="dl">Agent</span>
      <span class="dv" style="color:\${agentColor[c.agentId]}">\${esc(c.agentId)}</span>
      \${pos ? \`<span style="color:#334;font-size:10px;margin-left:6px">[\${pos}]</span>\` : ''}
    </div>
    <div class="dr"><span class="dl">Turn / type</span>
      <span class="dv">turn \${c.turnNumber}\${c.isReflection ? ' · <em style="color:#aaa">reflection</em>' : ''}\${sessionFirstSet.has(c) ? ' · <em style="color:#6080cc">wakeup</em>' : ''}</span></div>
    <div class="dr"><span class="dl">Time</span><span class="dv">\${fmtDT(c.savedAt)}</span></div>
    <div class="dr"><span class="dl">Model</span><span class="dv">\${esc(c.model) || '—'}</span></div>
    <div class="dr"><span class="dl">Stop reason</span><span class="dv">\${esc(c.stopReason) || '—'}</span></div>
    <div class="dr"><span class="dl">Cost</span><span class="dv">\${fmtC(c.costUsd)}</span></div>
    \${c.skillsUsed?.length ? \`<div class="dr"><span class="dl">Skills touched</span><span class="dv">\${c.skillsUsed.map(esc).join(', ')}</span></div>\` : ''}
    \${c.filesTouched?.length ? \`<div class="dr"><span class="dl">Files touched</span><span class="dv">\${c.filesTouched.map(f => esc((f.mode==='read'?'':'✎ ')+f.relPath)).join(', ')}</span></div>\` : ''}
    <div class="dr">
      <span class="dl">Tokens</span>
      <div class="tok-bar">
        <div style="flex:\${c.inputTokens};background:#4488ff"></div>
        <div style="flex:\${c.cacheReadTokens};background:#226622"></div>
        <div style="flex:\${c.outputTokens};background:#dd7722"></div>
        <div style="flex:\${c.cacheWriteTokens};background:#882299"></div>
      </div>
      <div class="tok-legend">
        <span style="color:#4488ff">■</span> in:\${fmtK(c.inputTokens)}&nbsp;
        <span style="color:#226622">■</span> cache:\${fmtK(c.cacheReadTokens)}&nbsp;
        <span style="color:#dd7722">■</span> out:\${fmtK(c.outputTokens)}&nbsp;
        <span style="color:#882299">■</span> write:\${fmtK(c.cacheWriteTokens)}
      </div>
    </div>
  \`;

  if (c.textOutput?.trim()) {
    html += \`
      <details open>
        <summary style="font-size:10px;color:#5566aa;cursor:pointer;user-select:none;padding:4px 0">
          LLM text output
        </summary>
        <div class="llm-text">\${esc(c.textOutput)}</div>
      </details>
    \`;
  }

  if (c.hasThinking) {
    html += \`
      <details class="thinking-block" open>
        <summary>🧠 Thinking\${c.thinkingSummary ? '' : ' (redacted)'}</summary>
        \${c.thinkingSummary
          ? \`<div class="thinking-text">\${esc(c.thinkingSummary)}</div>\`
          : \`<div class="thinking-text" style="color:#444">Content not available (redacted by model).</div>\`}
      </details>
    \`;
  }

  if (c.toolCalls?.length) {
    html += \`<div class="dl" style="margin-top:10px">\${c.toolCalls.length} tool call\${c.toolCalls.length > 1 ? 's' : ''}</div>\`;
    for (const t of c.toolCalls) {
      const hasResult = t.result !== null && t.result !== undefined;
      html += \`
        <details class="tool-block" open>
          <summary>
            <div class="tool-header">
              <span class="tool-name">\${esc(t.name)}</span>
              \${t.skill ? \`<span class="skill-badge">⚙ \${esc(t.skill)}\${t.skillAction ? ' · ' + esc(t.skillAction) : ''}</span>\` : ''}
              \${hasResult
                ? (t.isError
                  ? '<span class="tool-error">✗ error</span>'
                  : '<span class="tool-ok">✓ ok</span>')
                : '<span style="color:#445;font-size:10px">no result</span>'}
            </div>
          </summary>
          <div class="tool-section-label">Input</div>
          <div class="tool-code">\${esc(t.argsStr)}</div>
          \${hasResult ? \`
          <div class="tool-section-label">Output</div>
          <div class="tool-code \${t.isError ? 'tool-result-err' : 'tool-result'}">\${esc(t.result)}</div>
          \` : ''}
          \${t.files?.length ? \`
          <div class="tool-section-label">Files (\${t.files.length})</div>
          \${t.files.map(renderFileTouch).join('')}
          \` : ''}
        </details>
      \`;
    }
  } else {
    html += \`<div style="color:#333;font-size:11px;margin-top:8px">No tool calls — pure generation turn.</div>\`;
  }

  html += \`<div class="nav-hint">← → to navigate · same agent</div>\`;

  document.getElementById('detail-body').innerHTML = html;
}

// Arrow click: agent-to-agent message
function showMsgDetail(d) {
  document.getElementById('detail-body').innerHTML = \`
    <div class="dr"><span class="dl">From</span>
      <span class="dv" style="color:\${agentColor[d.from]}">\${d.from}</span></div>
    <div class="dr"><span class="dl">To</span>
      <span class="dv" style="color:\${agentColor[d.to]}">\${d.to}</span></div>
    <div class="dr"><span class="dl">Sent</span><span class="dv">\${fmtDT(d.msg.timestamp)}</span></div>
    \${d.wakeupMs ? \`<div class="dr"><span class="dl">Wakeup latency</span>
      <span class="dv">+\${Math.round((d.wakeupMs-d.sendMs)/60000)} min</span></div>\` : ''}
    <div class="dr"><span class="dl">Subject</span>
      <span class="dv"><strong>\${esc(d.msg.subject)}</strong></span></div>
    <div class="preview">\${esc(d.msg.bodyPreview)}</div>
  \`;
}

// Symbol click: user-in or user-out event
function showMsgEventDetail(evt) {
  const m = evt.msg;
  const isIn  = evt.kind === 'user-in';
  const color = isIn ? '#ffee55' : '#55ddff';
  const label = isIn ? '▲ User → Agent' : '■ Agent → User';
  const pos   = agentEvtPosition(evt.agentId, m);
  document.getElementById('detail-body').innerHTML = \`
    <div class="dr"><span class="dl">Type</span>
      <span class="dv" style="color:\${color}">\${label}</span>
      \${pos ? \`<span style="color:#334;font-size:10px;margin-left:6px">[\${pos}]</span>\` : ''}
    </div>
    <div class="dr"><span class="dl">Agent</span>
      <span class="dv" style="color:\${agentColor[evt.agentId]}">\${esc(evt.agentId)}</span></div>
    <div class="dr"><span class="dl">From</span><span class="dv">\${esc(m.from)}</span></div>
    <div class="dr"><span class="dl">To</span>
      <span class="dv">\${esc(Array.isArray(m.to) ? m.to.join(', ') : m.to)}</span></div>
    <div class="dr"><span class="dl">Sent</span><span class="dv">\${fmtDT(m.timestamp)}</span></div>
    <div class="dr"><span class="dl">Subject</span>
      <span class="dv"><strong>\${esc(m.subject)}</strong></span></div>
    <div class="preview">\${esc(m.bodyPreview)}</div>
    <div class="nav-hint">← → to navigate · same agent</div>
  \`;
}


// ═══════════════════════════════════════════════════════════════════════════════
// PAGE NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════
let filesPageInitialized = false;

function showPage(name) {
  document.getElementById('body').style.display = name === 'timeline' ? '' : 'none';
  const fp = document.getElementById('page-files');
  fp.style.display = name === 'files' ? 'flex' : 'none';
  document.querySelectorAll('.page-tab').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  if (name === 'files' && !filesPageInitialized) {
    filesPageInitialized = true;
    initFilesPage();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE EXPLORER
// ═══════════════════════════════════════════════════════════════════════════════
let fileHistoryMap = null;   // Map<relPath, { relPath, touches: [...] }>
let feSelectedPath = null;
let feSelectedTouchIdx = -1; // -1 = last write
let feFilterAgent = null;
let feFilterWritesOnly = true;
let feFilterType = null;
let feSearchText = '';

function feGetAllFiles() {
  if (!fileHistoryMap) return [];
  return [...fileHistoryMap.values()];
}

function feMatchesFilter(entry) {
  if (feFilterWritesOnly && !entry.touches.some(t => t.mode === 'write' || t.mode === 'edit')) return false;
  if (feFilterAgent && !entry.touches.some(t => t.agentId === feFilterAgent)) return false;
  if (feFilterType) {
    const ext = entry.relPath.split('.').pop()?.toLowerCase() ?? '';
    if (ext !== feFilterType) return false;
  }
  if (feSearchText) {
    if (!entry.relPath.toLowerCase().includes(feSearchText)) return false;
  }
  return true;
}

function initFilesPage() {
  fileHistoryMap = new Map();

  for (const call of TRACE.llmCalls) {
    for (const f of (call.filesTouched ?? [])) {
      if (!fileHistoryMap.has(f.relPath)) fileHistoryMap.set(f.relPath, { relPath: f.relPath, touches: [] });
      const toolCall = (call.toolCalls ?? []).find(tc =>
        (tc.files ?? []).some(fi => fi.relPath === f.relPath && fi.mode === f.mode)
      ) ?? null;
      const tcFile = toolCall
        ? (toolCall.files ?? []).find(fi => fi.relPath === f.relPath && fi.mode === f.mode)
        : null;
      fileHistoryMap.get(f.relPath).touches.push({
        agentId: call.agentId, savedAt: call.savedAt, turnNumber: call.turnNumber,
        mode: f.mode, content: tcFile?.content ?? null,
        oldString: tcFile?.oldString ?? null, newString: tcFile?.newString ?? null,
        llmCallIdx: TRACE.llmCalls.indexOf(call), toolCall,
      });
    }
  }

  for (const e of fileHistoryMap.values())
    e.touches.sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt));

  // Agent filter chips
  const agentChipsEl = document.getElementById('fe-agent-chips');
  for (const agent of TRACE.summary.agentIds) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.color = agentColor[agent] || '';
    chip.textContent = agent;
    chip.onclick = () => feSetAgent(agent);
    agentChipsEl.appendChild(chip);
  }

  // File type filter chips
  const typeRow = document.getElementById('fe-type-chips');
  const allExts = new Set();
  for (const e of fileHistoryMap.values()) {
    const ext = e.relPath.split('.').pop()?.toLowerCase() ?? '';
    if (ext) allExts.add(ext);
  }
  typeRow.innerHTML = '<span class="files-chip-lbl">Type</span>';
  for (const ext of [...allExts].sort()) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.fontSize = '9px';
    chip.textContent = '.' + ext;
    chip.onclick = () => feSetType(ext);
    typeRow.appendChild(chip);
  }

  document.getElementById('files-search').oninput = e => {
    feSearchText = e.target.value.toLowerCase().trim();
    feBuildTree();
  };

  feBuildTree();
}

function feSetAgent(agent) {
  feFilterAgent = feFilterAgent === agent ? null : agent;
  document.getElementById('fe-agent-all').classList.toggle('tc-active', !feFilterAgent);
  document.querySelectorAll('#fe-agent-chips .chip').forEach(c => {
    c.classList.toggle('tc-active', c.textContent === feFilterAgent);
  });
  feBuildTree();
}

function feToggleWrites() {
  feFilterWritesOnly = !feFilterWritesOnly;
  document.getElementById('fe-writes-only').classList.toggle('active', feFilterWritesOnly);
  feBuildTree();
}

function feSetType(ext) {
  feFilterType = feFilterType === ext ? null : ext;
  document.querySelectorAll('#fe-type-chips .chip').forEach(c => {
    c.classList.toggle('tc-active', c.textContent === '.' + feFilterType);
  });
  feBuildTree();
}

function feBuildTree() {
  const container = document.getElementById('file-tree-container');
  container.innerHTML = '';
  const filtered = feGetAllFiles().filter(feMatchesFilter);
  document.getElementById('files-tree-count').textContent =
    filtered.length + ' file' + (filtered.length !== 1 ? 's' : '');

  // Build directory tree
  const root = {};
  for (const entry of filtered) {
    const parts = entry.relPath.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = node[parts[i]] || { __children: {} };
      node = node[parts[i]].__children;
    }
    const fname = parts[parts.length - 1];
    node[fname] = { __entry: entry };
  }

  feRenderLevel(container, root, 0);
}

function feRenderLevel(parentEl, nodes, depth) {
  const entries = Object.entries(nodes).sort(([a], [b]) => {
    const aIsDir = !nodes[a].__entry;
    const bIsDir = !nodes[b].__entry;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.localeCompare(b);
  });

  for (const [name, node] of entries) {
    if (name === '__entry' || name === '__children') continue;

    if (node.__entry) {
      // File leaf
      const entry = node.__entry;
      const hasWrite = entry.touches.some(t => t.mode === 'write' || t.mode === 'edit');
      const item = document.createElement('div');
      item.className = 'tree-file-item' + (hasWrite ? ' has-write' : '');
      item.style.paddingLeft = (8 + depth * 14) + 'px';
      if (entry.relPath === feSelectedPath) item.classList.add('fe-selected');

      const agentDots = document.createElement('div');
      agentDots.className = 'tree-agent-dots';
      const agentsForFile = [...new Set(entry.touches.map(t => t.agentId))];
      for (const ag of agentsForFile) {
        const dot = document.createElement('div');
        dot.className = 'tree-agent-dot';
        dot.style.background = agentColor[ag] || '#5566aa';
        dot.title = ag;
        agentDots.appendChild(dot);
      }

      item.appendChild(document.createTextNode(name));
      item.appendChild(agentDots);
      item.onclick = () => feSelectFile(entry.relPath);
      parentEl.appendChild(item);
    } else {
      // Directory
      const label = document.createElement('div');
      label.className = 'tree-dir-label';
      label.style.paddingLeft = (8 + depth * 14) + 'px';
      const arrow = document.createElement('span');
      arrow.className = 'tree-arrow';
      arrow.textContent = '▾';
      label.appendChild(arrow);
      label.appendChild(document.createTextNode(name + '/'));

      const kids = document.createElement('div');
      kids.className = 'tree-dir-children';
      feRenderLevel(kids, node.__children, depth + 1);

      label.onclick = () => {
        const collapsed = kids.classList.toggle('tree-collapsed');
        arrow.textContent = collapsed ? '▸' : '▾';
      };
      parentEl.appendChild(label);
      parentEl.appendChild(kids);
    }
  }
}

function feSelectFile(relPath) {
  feSelectedPath = relPath;
  feSelectedTouchIdx = -1;
  document.querySelectorAll('.tree-file-item').forEach(el => {
    el.classList.toggle('fe-selected', el.textContent.trim().startsWith(relPath.split('/').pop()));
  });
  feRenderContent(relPath);
  feRenderProvenance(relPath);
}

function feHighlightJson(raw) {
  let text; try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch { text = raw; }
  text = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  text = text.replace(/"([^"]+)":/g, (_,k) => \`"<span class="json-key">\${k}</span>":\`);
  text = text.replace(/: "([^"]*)"/g, (_,v) => \`: "<span class="json-str">\${v}</span>"\`);
  text = text.replace(/: (-?[0-9]+(?:[.][0-9]*)?(?:[eE][0-9]+)?)/g, (_,n) => \`: <span class="json-num">\${n}</span>\`);
  text = text.replace(/: (true|false|null)/g, (_,v) => \`: <span class="json-bool">\${v}</span>\`);
  return text;
}

function feHighlightXml(raw) {
  let text = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  text = text.replace(/(&lt;!--[^]*?--&gt;)/g, m => \`<span class="xml-comment">\${m}</span>\`);
  text = text.replace(/(&lt;[/]?)([-_.:A-Za-z0-9]+)/g, (_,lt,n) => \`\${lt}<span class="xml-tag">\${n}</span>\`);
  text = text.replace(/([-_.:A-Za-z0-9]+)="([^"]*)"/g, (_,a,v) => \`<span class="xml-attr">\${a}</span>="<span class="xml-val">\${v}</span>"\`);
  return text;
}

function feParseMarkdown(md) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const inline = s => s
    .replace(/\`([^\`]+)\`/g, (_,c) => \`<code>\${esc(c)}</code>\`)
    .replace(/[*][*]([^*]+)[*][*]/g, (_,t) => \`<strong>\${t}</strong>\`)
    .replace(/[*]([^*]+)[*]/g, (_,t) => \`<em>\${t}</em>\`);
  const lines = md.split('\\n');
  const out = [];
  let inList = false, listTag = '';
  for (const raw of lines) {
    const l = esc(raw);
    let m;
    if ((m = l.match(/^(#{1,6}) (.*)/))) {
      if (inList) { out.push(\`</\${listTag}>\`); inList = false; }
      out.push(\`<h\${m[1].length}>\${inline(m[2])}</h\${m[1].length}>\`);
    } else if (l.match(/^---+$/)) {
      if (inList) { out.push(\`</\${listTag}>\`); inList = false; }
      out.push('<hr>');
    } else if ((m = l.match(/^[-*] (.*)/))) {
      if (!inList || listTag !== 'ul') { if (inList) out.push(\`</\${listTag}>\`); out.push('<ul>'); inList = true; listTag = 'ul'; }
      out.push(\`<li>\${inline(m[1])}</li>\`);
    } else if ((m = l.match(/^[0-9]+[.] (.*)/))) {
      if (!inList || listTag !== 'ol') { if (inList) out.push(\`</\${listTag}>\`); out.push('<ol>'); inList = true; listTag = 'ol'; }
      out.push(\`<li>\${inline(m[1])}</li>\`);
    } else if (l.trim() === '') {
      if (inList) { out.push(\`</\${listTag}>\`); inList = false; }
      out.push('');
    } else {
      if (inList) { out.push(\`</\${listTag}>\`); inList = false; }
      out.push(\`<p>\${inline(l)}</p>\`);
    }
  }
  if (inList) out.push(\`</\${listTag}>\`);
  return out.join('\\n');
}

function feRenderContent(relPath) {
  const entry = fileHistoryMap.get(relPath);
  const header = document.getElementById('files-content-path');
  const selector = document.getElementById('files-touch-selector');
  const body = document.getElementById('files-content-body');
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  header.textContent = relPath;
  selector.innerHTML = '';

  const writeTouches = entry.touches.filter(t => t.mode === 'write' || t.mode === 'edit');
  if (!writeTouches.length) {
    body.className = 'fe-plain';
    body.textContent = 'Read-only — no write touches captured.';
    return;
  }

  const idx = feSelectedTouchIdx < 0 ? writeTouches.length - 1 : Math.min(feSelectedTouchIdx, writeTouches.length - 1);

  writeTouches.forEach((t, i) => {
    const chip = document.createElement('span');
    chip.className = 'touch-chip' + (i === idx ? ' tc-active' : '');
    chip.textContent = t.agentId.replace(/-/g,' ').replace(/analyst/,'') + ' t' + t.turnNumber;
    chip.title = fmtDT(t.savedAt) + ' · ' + t.mode;
    chip.onclick = () => { feSelectedTouchIdx = i; feRenderContent(relPath); };
    selector.appendChild(chip);
  });

  const touch = writeTouches[idx];

  if (!touch.content) {
    if (touch.mode === 'edit' && (touch.oldString != null || touch.newString != null)) {
      body.className = '';
      body.innerHTML =
        (touch.oldString != null ? \`<div class="diff-del">\${esc(touch.oldString)}</div>\` : '') +
        (touch.newString != null ? \`<div class="diff-add">\${esc(touch.newString)}</div>\` : '');
      return;
    }
    const scriptOutput = touch.toolCall?.result ?? null;
    if (scriptOutput) {
      body.className = '';
      body.innerHTML =
        '<div style="font-size:9px;color:#334;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px;">Script output (file content not captured)</div>' +
        \`<pre style="white-space:pre-wrap;word-break:break-all;font-size:10px;color:#6a8a70;">\${esc(scriptOutput)}</pre>\`;
    } else {
      body.className = 'fe-plain';
      const writers = [...new Set(entry.touches.filter(t => t.mode === 'write' || t.mode === 'edit').map(t => t.agentId))];
      body.innerHTML = 'Content not captured for this touch.<br><br>' +
        '<span style="color:#334;font-size:9px;">Written by: ' + writers.join(', ') + '</span>';
    }
    return;
  }

  const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md') {
    body.className = 'fe-md';
    body.innerHTML = feParseMarkdown(touch.content);
  } else if (ext === 'json') {
    body.className = '';
    body.innerHTML = feHighlightJson(touch.content);
  } else if (ext === 'xml') {
    body.className = '';
    body.innerHTML = feHighlightXml(touch.content);
  } else {
    body.className = '';
    body.textContent = touch.content;
  }
}

function feRenderProvenance(relPath) {
  const entry = fileHistoryMap.get(relPath);
  const body = document.getElementById('files-provenance-body');
  body.innerHTML = '';
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Group touches by agent
  const byAgent = {};
  for (const t of entry.touches) {
    (byAgent[t.agentId] = byAgent[t.agentId] || []).push(t);
  }

  for (const [agent, touches] of Object.entries(byAgent)) {
    const section = document.createElement('div');
    section.className = 'prov-section';

    const agRow = document.createElement('div');
    agRow.className = 'prov-agent-row';
    agRow.style.color = agentColor[agent] || '#7888aa';
    const dot = document.createElement('span');
    dot.className = 'prov-dot';
    dot.style.background = agentColor[agent] || '#7888aa';
    const nm = document.createElement('span');
    nm.textContent = agent;
    agRow.appendChild(dot);
    agRow.appendChild(nm);
    section.appendChild(agRow);

    for (const t of touches) {
      const row = document.createElement('div');
      row.className = 'prov-touch-item';
      row.style.cursor = 'pointer';

      const modeEl = document.createElement('span');
      modeEl.className = 'prov-mode pm-' + t.mode;
      modeEl.textContent = t.mode;
      const timeEl = document.createElement('span');
      timeEl.textContent = fmtDT(t.savedAt).replace(/^\S+\s/, '');
      const turnEl = document.createElement('span');
      turnEl.style.color = '#334';
      turnEl.textContent = 't' + t.turnNumber;
      const expandBtn = document.createElement('button');
      expandBtn.className = 'prov-expand-btn';
      expandBtn.textContent = '▶';
      row.appendChild(modeEl);
      row.appendChild(timeEl);
      row.appendChild(turnEl);
      row.appendChild(expandBtn);

      const detail = document.createElement('div');
      detail.className = 'prov-touch-detail';

      if (t.toolCall) {
        const tcs = document.createElement('div');
        tcs.className = 'prov-detail-section';
        if (t.toolCall.input) {
          const il = document.createElement('div'); il.className = 'prov-detail-label'; il.textContent = 'Input';
          const it = document.createElement('div'); it.className = 'prov-detail-text';
          it.textContent = typeof t.toolCall.input === 'string'
            ? t.toolCall.input : JSON.stringify(t.toolCall.input, null, 2);
          tcs.appendChild(il); tcs.appendChild(it);
        }
        if (t.toolCall.result) {
          const rl = document.createElement('div'); rl.className = 'prov-detail-label'; rl.style.marginTop = '4px'; rl.textContent = 'Output';
          const rt = document.createElement('div');
          rt.className = t.toolCall.isError ? 'prov-detail-err' : 'prov-detail-code';
          rt.textContent = t.toolCall.result;
          tcs.appendChild(rl); tcs.appendChild(rt);
        }
        detail.appendChild(tcs);
      } else {
        const na = document.createElement('div');
        na.style.cssText = 'font-size:9px;color:#334;font-style:italic;';
        na.textContent = 'No LLM call data available.';
        detail.appendChild(na);
      }

      const toggle = () => {
        const open = detail.classList.toggle('open');
        expandBtn.textContent = open ? '▼' : '▶';
      };
      row.onclick = toggle;
      expandBtn.onclick = e => { e.stopPropagation(); toggle(); };

      section.appendChild(row);
      section.appendChild(detail);
    }
    body.appendChild(section);
  }

  // Mini timeline bar showing all touches
  const t0ms = new Date(TRACE.summary.startTime).getTime();
  const t1ms = new Date(TRACE.summary.endTime).getTime();
  const dur = t1ms - t0ms || 1;

  const tlWrap = document.createElement('div');
  tlWrap.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid #161a28;';
  const tlLbl = document.createElement('div');
  tlLbl.style.cssText = 'font-size:9px;color:#334;text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px;';
  tlLbl.textContent = 'Timeline';
  const tlBar = document.createElement('div');
  tlBar.className = 'prov-tl-bar';
  for (const t of entry.touches) {
    const pct = ((new Date(t.savedAt).getTime() - t0ms) / dur) * 100;
    const tick = document.createElement('div');
    tick.className = 'prov-tl-tick';
    tick.style.cssText += \`left:\${pct}%;background:\${agentColor[t.agentId] || '#5566aa'};\`;
    tick.title = \`\${t.agentId} · \${fmtDT(t.savedAt)} · \${t.mode}\`;
    tlBar.appendChild(tick);
  }
  tlWrap.appendChild(tlLbl);
  tlWrap.appendChild(tlBar);
  body.appendChild(tlWrap);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════════
window.addEventListener('resize', build);
init();
</script>
</body>
</html>`;
}
