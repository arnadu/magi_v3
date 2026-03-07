import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { Db } from "mongodb";
import type { MailboxRepository } from "./mailbox.js";
import type { UsageAccumulator } from "./usage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MonitorEventType =
	| "mailbox-msg"
	| "llm-call"
	| "step-paused"
	| "step-resumed"
	| "mental-map-update"
	| "conversation-update"
	| "shutdown"
	| "cost-limit"
	| "status"
	| "started";

export interface AgentInfo {
	id: string;
	name: string;
	role: string;
}

// ---------------------------------------------------------------------------
// Monitor server
// ---------------------------------------------------------------------------

/**
 * HTTP + SSE monitoring dashboard.
 *
 * Routes:
 *   GET  /                          HTML dashboard
 *   GET  /events                    SSE stream
 *   GET  /team                      JSON agent roster
 *   GET  /status                    JSON usage + mission info
 *   GET  /agents/:id/mental-map     current mental map HTML
 *   GET  /agents/:id/conversation   last N conversation messages
 *   POST /send-message              inject a mailbox message  { to, subject, body }
 *   POST /step                      advance one step (resolves waitForStep)
 *   POST /toggle-step               enable / disable step mode
 *   POST /stop                      graceful daemon shutdown
 */
export class MonitorServer {
	private readonly clients = new Set<ServerResponse>();
	private readonly server;

	// Start gate
	private started = false;
	private startResolve: (() => void) | null = null;

	// Step mode
	private stepEnabled = false;
	private stepResolve: (() => void) | null = null;

	constructor(
		private readonly db: Db,
		private readonly missionId: string,
		private readonly missionName: string,
		private readonly model: string,
		private readonly accumulator: UsageAccumulator,
		private readonly mailboxRepo: MailboxRepository,
		private readonly agents: AgentInfo[],
		private readonly onStop: () => void,
		private readonly maxCostUsd: number | null,
		private readonly startedAt = new Date(),
	) {
		this.server = createServer((req, res) =>
			this.handleRequest(req, res).catch((e) => {
				console.error("[monitor] Request error:", e);
				if (!res.headersSent) res.writeHead(500).end();
			}),
		);
	}

	// ── Public API ────────────────────────────────────────────────────────────

	push(type: MonitorEventType, payload: unknown): void {
		const line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
		for (const client of this.clients) {
			try {
				client.write(line);
			} catch {
				this.clients.delete(client);
			}
		}
	}

	/**
	 * Blocks until the operator clicks "Start" in the dashboard.
	 * Resolves immediately if already started (e.g. daemon restarted).
	 */
	waitForStart(): Promise<void> {
		if (this.started) return Promise.resolve();
		return new Promise((resolve) => {
			this.startResolve = resolve;
		});
	}

	/** Called by the orchestrator after every agent turn when step mode is on. */
	waitForStep(): Promise<void> {
		if (!this.stepEnabled) return Promise.resolve();
		this.push("step-paused", {});
		return new Promise((resolve) => {
			this.stepResolve = resolve;
		});
	}

	async start(port: number): Promise<void> {
		void this.watchMailbox();
		void this.watchConversations();
		void this.watchMentalMaps();

		await new Promise<void>((resolve, reject) => {
			this.server.listen(port, "0.0.0.0", () => resolve());
			this.server.once("error", reject);
		});
		console.log(`[monitor] Dashboard: http://localhost:${port}`);
	}

	stop(): void {
		this.server.close();
		for (const client of this.clients) {
			try {
				client.end();
			} catch {}
		}
	}

	// ── Request handler ───────────────────────────────────────────────────────

	private async handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const url = req.url?.split("?")[0] ?? "/";
		res.setHeader("Access-Control-Allow-Origin", "*");

		// ── GET /
		if (url === "/" || url === "/index.html") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(this.buildHtml());
			return;
		}

		// ── GET /events
		if (url === "/events" && req.method === "GET") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.write("retry: 3000\n\n");
			res.write(
				`event: status\ndata: ${JSON.stringify(this.statusPayload())}\n\n`,
			);
			this.clients.add(res);
			req.on("close", () => this.clients.delete(res));
			return;
		}

		// ── GET /team
		if (url === "/team" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(this.agents));
			return;
		}

		// ── GET /status
		if (url === "/status" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(this.statusPayload()));
			return;
		}

		// ── GET /agents/:id/mental-map
		const mentalMapMatch = url.match(/^\/agents\/([^/]+)\/mental-map$/);
		if (mentalMapMatch && req.method === "GET") {
			const agentId = decodeURIComponent(mentalMapMatch[1]);
			const doc = await this.db.collection("mental_maps").findOne({ agentId });
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					agentId,
					html: (doc as { html?: string } | null)?.html ?? "",
				}),
			);
			return;
		}

		// ── GET /agents/:id/conversation
		const convoMatch = url.match(/^\/agents\/([^/]+)\/conversation$/);
		if (convoMatch && req.method === "GET") {
			const agentId = decodeURIComponent(convoMatch[1]);
			const msgs = await this.db
				.collection("conversationMessages")
				.find({ missionId: this.missionId, agentId })
				.sort({ turnNumber: 1, timestamp: 1 })
				.limit(200)
				.toArray();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(msgs));
			return;
		}

		// ── POST /send-message
		if (url === "/send-message" && req.method === "POST") {
			const body = await readBody(req);
			const { to, subject, message } = JSON.parse(body) as {
				to: string[];
				subject: string;
				message: string;
			};
			await this.mailboxRepo.post({
				missionId: this.missionId,
				from: "user",
				to,
				subject: subject || "Operator message",
				body: message,
			});
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			return;
		}

		// ── POST /step
		if (url === "/step" && req.method === "POST") {
			if (this.stepResolve) {
				this.stepResolve();
				this.stepResolve = null;
				this.push("step-resumed", {});
				console.log("[monitor] Step advanced via dashboard");
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, stepEnabled: this.stepEnabled }));
			return;
		}

		// ── POST /toggle-step
		if (url === "/toggle-step" && req.method === "POST") {
			this.stepEnabled = !this.stepEnabled;
			// If disabling while paused, release the pending step.
			if (!this.stepEnabled && this.stepResolve) {
				this.stepResolve();
				this.stepResolve = null;
				this.push("step-resumed", {});
			}
			console.log(`[monitor] Step mode: ${this.stepEnabled ? "ON" : "OFF"}`);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, stepEnabled: this.stepEnabled }));
			return;
		}

		// ── POST /start
		if (url === "/start" && req.method === "POST") {
			if (!this.started) {
				this.started = true;
				if (this.startResolve) {
					this.startResolve();
					this.startResolve = null;
				}
				this.push("started", {});
				console.log("[monitor] Mission started via dashboard");
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			return;
		}

		// ── POST /stop
		if (url === "/stop" && req.method === "POST") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			console.log("[monitor] Stop requested via dashboard");
			this.push("shutdown", { reason: "operator-stop" });
			this.onStop();
			return;
		}

		res.writeHead(404).end();
	}

	// ── Change stream watchers ────────────────────────────────────────────────

	private async watchMailbox(): Promise<void> {
		try {
			const stream = this.db.collection("mailbox").watch(
				[
					{
						$match: {
							operationType: "insert",
							"fullDocument.missionId": this.missionId,
						},
					},
				],
				{ fullDocument: "updateLookup" },
			);
			stream.on("change", (change) => {
				if (change.operationType !== "insert") return;
				const doc = change.fullDocument as {
					_id: unknown;
					from: string;
					to: string[];
					subject: string;
					body: string;
					timestamp?: Date;
				};
				this.push("mailbox-msg", {
					id: String(doc._id),
					from: doc.from,
					to: doc.to,
					subject: doc.subject,
					bodyPreview:
						doc.body.length > 400 ? `${doc.body.slice(0, 400)}…` : doc.body,
					timestamp: (doc.timestamp ?? new Date()).toISOString(),
				});
				this.push("status", this.statusPayload());
			});
			stream.on("error", (e) =>
				console.error("[monitor] Mailbox watch error:", e.message),
			);
		} catch (e) {
			console.error("[monitor] Could not open mailbox Change Stream:", e);
		}
	}

	private async watchConversations(): Promise<void> {
		try {
			const stream = this.db.collection("conversationMessages").watch(
				[
					{
						$match: {
							operationType: "insert",
							"fullDocument.missionId": this.missionId,
						},
					},
				],
				{ fullDocument: "updateLookup" },
			);
			stream.on("change", (change) => {
				if (change.operationType !== "insert") return;
				const doc = change.fullDocument as { agentId: string } & Record<
					string,
					unknown
				>;
				this.push("conversation-update", {
					agentId: doc.agentId,
					message: doc,
				});
			});
			stream.on("error", (e) =>
				console.error("[monitor] Conversation watch error:", e.message),
			);
		} catch (e) {
			console.error("[monitor] Could not open conversation Change Stream:", e);
		}
	}

	private async watchMentalMaps(): Promise<void> {
		try {
			const agentIds = this.agents.map((a) => a.id);
			const stream = this.db
				.collection("mental_maps")
				.watch([{ $match: { "fullDocument.agentId": { $in: agentIds } } }], {
					fullDocument: "updateLookup",
				});
			stream.on("change", (change) => {
				const doc = (
					change as { fullDocument?: { agentId?: string; html?: string } }
				).fullDocument;
				if (doc?.agentId) {
					this.push("mental-map-update", {
						agentId: doc.agentId,
						html: doc.html ?? "",
					});
				}
			});
			stream.on("error", (e) =>
				console.error("[monitor] Mental map watch error:", e.message),
			);
		} catch (e) {
			console.error("[monitor] Could not open mental map Change Stream:", e);
		}
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	private statusPayload() {
		const uptimeSec = Math.floor(
			(Date.now() - this.startedAt.getTime()) / 1000,
		);
		return {
			missionId: this.missionId,
			missionName: this.missionName,
			model: this.model,
			uptimeSec,
			started: this.started,
			stepEnabled: this.stepEnabled,
			missionTotalUsd: this.accumulator.totalCostUsd(),
			maxCostUsd: this.maxCostUsd,
			agents: this.accumulator.agents().map((a) => ({
				agentId: a.agentId,
				input: a.input,
				output: a.output,
				cacheRead: a.cacheRead,
				llmCalls: a.llmCalls,
				costUsd: a.costUsd,
			})),
		};
	}

	// ── HTML ──────────────────────────────────────────────────────────────────

	private buildHtml(): string {
		const agentIds = this.agents.map((a) => a.id);
		const agentJson = JSON.stringify(this.agents);
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAGI Monitor</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0d1117; --surface: #161b22; --border: #30363d;
  --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
  --red: #f85149; --green: #3fb950; --yellow: #d29922; --orange: #ffa657;
  --c0: #58a6ff; --c1: #3fb950; --c2: #e3b341; --c3: #bc8cff;
  --c4: #ffa657; --c-sched: #8b949e; --c-user: #ffa657;
}
body { background:var(--bg); color:var(--text); font:13px/1.5 "SF Mono","Fira Code",monospace;
       height:100vh; display:grid; grid-template-rows:auto 1fr auto; overflow:hidden; }

/* ── Header ── */
header { background:var(--surface); border-bottom:1px solid var(--border);
         padding:8px 14px; display:flex; align-items:center; gap:10px; flex-shrink:0; flex-wrap:wrap; }
.dot { width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;
       animation:blink 2s infinite; }
.dot.dead { background:var(--red);animation:none; }
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.hname { font-size:14px;font-weight:600;color:var(--accent); }
.hmeta { color:var(--muted);font-size:11px; }
.hcost { font-weight:600; }
.hcost.warn { color:var(--yellow); }
.hcost.danger { color:var(--red);animation:pulse 1s infinite; }
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.hup { color:var(--muted);font-size:11px; }
.spacer { flex:1; }
.btn { background:var(--surface);border:1px solid var(--border);color:var(--text);
       border-radius:5px;padding:5px 12px;font:12px/1 monospace;cursor:pointer; }
.btn:hover:not(:disabled) { background:#21262d; }
.btn:disabled { opacity:.4;cursor:default; }
.btn-start  { border-color:#3fb950;color:#3fb950;font-weight:600; }
.btn-start.running { background:#3fb950;color:#000;border-color:#3fb950; }
.btn-step   { border-color:var(--accent);color:var(--accent); }
.btn-step.on{ background:var(--accent);color:#000;border-color:var(--accent); }
.btn-step.waiting { background:var(--yellow);color:#000;border-color:var(--yellow);animation:pulse .8s infinite; }
.btn-stop   { border-color:var(--red);color:var(--red); }

/* ── Main split ── */
main { display:grid; grid-template-columns:1fr 1fr; overflow:hidden; }

/* ── Left column: message feed + usage ── */
.left-col { display:flex;flex-direction:column;border-right:1px solid var(--border);overflow:hidden; }
.feed { flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:7px; }
.msg { background:var(--surface);border:1px solid var(--border);border-radius:6px;
       padding:9px 11px;border-left:3px solid var(--border); }
.msg-hdr { display:flex;align-items:baseline;gap:7px;margin-bottom:3px; }
.msg-from { font-weight:600;font-size:12px; }
.msg-to   { color:var(--muted);font-size:11px; }
.msg-time { color:var(--muted);font-size:10px;margin-left:auto; }
.msg-subj { font-size:12px;font-weight:500;margin-bottom:2px; }
.msg-body { font-size:11px;color:var(--muted);white-space:pre-wrap;word-break:break-word; }
.msg-sys  { font-size:11px;color:var(--muted);font-style:italic; }

/* ── Usage bar (bottom of left col) ── */
.usage-bar { border-top:1px solid var(--border);padding:7px 10px;background:var(--surface);
             font-size:11px;flex-shrink:0; }
.usage-row { display:flex;gap:12px;flex-wrap:wrap;align-items:center; }
.u-agent { font-weight:600; }
.u-val   { color:var(--muted); }
.u-total { color:var(--accent);font-weight:600;margin-left:auto; }
.cap-bar { height:3px;background:var(--border);border-radius:2px;margin-top:5px; }
.cap-fill{ height:100%;border-radius:2px;background:var(--accent);transition:width .4s; }

/* ── Right col: agent tabs + detail ── */
.right-col { display:flex;flex-direction:column;overflow:hidden; }
.agent-tabs { display:flex;border-bottom:1px solid var(--border);background:var(--surface);
              padding:0 8px;gap:2px;flex-shrink:0;overflow-x:auto; }
.agent-tab { padding:8px 12px;font-size:12px;cursor:pointer;border-bottom:2px solid transparent;
             color:var(--muted);white-space:nowrap;transition:color .15s; }
.agent-tab:hover { color:var(--text); }
.agent-tab.active { color:var(--text);border-bottom-color:var(--accent); }
.sub-tabs { display:flex;border-bottom:1px solid var(--border);background:#0d1117;padding:0 10px;
            gap:1px;flex-shrink:0; }
.sub-tab { padding:6px 10px;font-size:11px;cursor:pointer;color:var(--muted);
           border-bottom:2px solid transparent; }
.sub-tab:hover { color:var(--text); }
.sub-tab.active { color:var(--accent);border-bottom-color:var(--accent); }
.detail-pane { flex:1;overflow-y:auto;padding:10px; }

/* ── Mental map ── */
.mental-map-html { font-size:12px;line-height:1.6; }
.mental-map-html section { margin-bottom:12px;padding:8px;background:var(--surface);
                            border:1px solid var(--border);border-radius:4px; }
.mental-map-html ul { padding-left:16px; }
.mental-map-html li { margin-bottom:2px; }
.mental-map-html p  { color:var(--text); }

/* ── Conversation ── */
.conv-msg { margin-bottom:8px;border-radius:5px;padding:7px 9px;font-size:11px; }
.conv-user { background:#1c2028;border-left:3px solid var(--muted); }
.conv-assistant { background:#162030;border-left:3px solid var(--accent); }
.conv-toolResult{ background:#1a1f1a;border-left:3px solid #3fb950; }
.conv-role { font-weight:600;font-size:10px;color:var(--muted);margin-bottom:3px; }
.conv-text { white-space:pre-wrap;word-break:break-word;color:var(--text); }
.conv-tool { color:var(--yellow);font-size:10px; }
.conv-result{ color:#3fb950;font-size:10px; }
.conv-err   { color:var(--red);font-size:10px; }

/* ── Compose modal ── */
.overlay { position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;
           justify-content:center;z-index:10; }
.overlay.hidden { display:none; }
.compose { background:var(--surface);border:1px solid var(--border);border-radius:8px;
           padding:20px;width:560px;max-width:95vw; }
.compose h2 { font-size:14px;margin-bottom:14px;color:var(--text); }
.field { margin-bottom:12px; }
.field label { display:block;font-size:11px;color:var(--muted);margin-bottom:4px; }
.field input,.field textarea,.field select {
  width:100%;background:#0d1117;border:1px solid var(--border);color:var(--text);
  border-radius:4px;padding:6px 8px;font:12px/1.5 monospace; }
.field textarea { height:120px;resize:vertical; }
.agent-checks { display:flex;gap:10px;flex-wrap:wrap;margin-top:4px; }
.agent-checks label { font-size:12px;cursor:pointer;display:flex;gap:4px;align-items:center; }
.compose-actions { display:flex;justify-content:flex-end;gap:8px;margin-top:4px; }
.btn-send { background:var(--green);border:none;color:#000;font-weight:600; }
.btn-send:hover { opacity:.85; }
.btn-cancel { background:transparent;border:1px solid var(--border);color:var(--muted); }

/* Agent colours (by index 0–3, then scheduler/user) */
${agentIds.map((id, i) => `.ac-${id.replace(/-/g, "\\-")}{color:var(--c${i})} .ab-${id.replace(/-/g, "\\-")}{border-left-color:var(--c${i})}`).join("\n")}
.ac-scheduler{color:var(--c-sched)} .ab-scheduler{border-left-color:var(--c-sched)}
.ac-user{color:var(--c-user)} .ab-user{border-left-color:var(--c-user)}

.empty-state { color:var(--muted);text-align:center;padding:24px;font-size:11px; }
</style>
</head>
<body>

<header>
  <span class="dot" id="dot"></span>
  <span class="hname" id="hname">MAGI</span>
  <span class="hmeta" id="hmeta"></span>
  <span class="hcost" id="hcost">$0.0000</span>
  <span class="hup" id="hup"></span>
  <span class="spacer"></span>
  <button class="btn btn-start" id="start-btn" onclick="startMission()">▶ Start</button>
  <button class="btn btn-start" onclick="openCompose()">✉ Send</button>
  <button class="btn btn-step" id="step-btn" onclick="toggleStep()">Step: OFF</button>
  <button class="btn btn-step" id="advance-btn" onclick="advance()" disabled style="display:none">▶ Advance</button>
  <button class="btn btn-stop" id="stop-btn" onclick="stopDaemon()">■ Stop</button>
</header>

<main>
  <!-- Left: message feed + usage -->
  <div class="left-col">
    <div class="feed" id="feed">
      <div class="empty-state">Waiting for messages…</div>
    </div>
    <div class="usage-bar">
      <div class="usage-row" id="usage-row">
        <span style="color:var(--muted)">No LLM calls yet</span>
        <span class="u-total" id="u-total">$0.0000</span>
      </div>
      <div id="cap-wrap" style="display:none">
        <div class="cap-bar"><div class="cap-fill" id="cap-fill" style="width:0%"></div></div>
      </div>
    </div>
  </div>

  <!-- Right: agent tabs + detail -->
  <div class="right-col">
    <div class="agent-tabs" id="agent-tabs">
      ${agentIds
				.map((id, i) => {
					const name = this.agents[i]?.name ?? id;
					return `<div class="agent-tab ac-${id}" data-id="${id}" onclick="selectAgent('${id}')">${name}</div>`;
				})
				.join("")}
    </div>
    <div class="sub-tabs">
      <div class="sub-tab active" id="st-mm" onclick="selectSubTab('mm')">Mental Map</div>
      <div class="sub-tab" id="st-cv" onclick="selectSubTab('cv')">Conversation</div>
    </div>
    <div class="detail-pane" id="detail-pane">
      <div class="empty-state">Select an agent tab above</div>
    </div>
  </div>
</main>

<!-- Compose overlay -->
<div class="overlay hidden" id="compose-overlay" onclick="closeComposeIfBg(event)">
  <div class="compose">
    <h2>Send message</h2>
    <div class="field">
      <label>To</label>
      <div class="agent-checks" id="to-checks">
        ${this.agents
					.map(
						(a) => `
          <label><input type="checkbox" value="${a.id}" id="chk-${a.id}"> ${a.name} (${a.role})</label>`,
					)
					.join("")}
        <label style="margin-left:auto;color:var(--muted);cursor:pointer" onclick="checkAll()">All</label>
      </div>
    </div>
    <div class="field">
      <label>Subject</label>
      <input type="text" id="compose-subject" placeholder="(optional)">
    </div>
    <div class="field">
      <label>Message</label>
      <textarea id="compose-body" placeholder="Type your message…"></textarea>
    </div>
    <div class="compose-actions">
      <button class="btn btn-cancel" onclick="closeCompose()">Cancel</button>
      <button class="btn btn-send" onclick="sendMessage()">Send</button>
    </div>
  </div>
</div>

<script>
const AGENTS = ${agentJson};
const es = new EventSource('/events');
let activeAgent = null;
let activeSubTab = 'mm';
let missionStarted = false;
let stepEnabled = false;
let stepWaiting = false;
let startedAt = Date.now();
let maxCostUsd = null;
let stopped = false;

// ── SSE ──────────────────────────────────────────────────────────────
es.onopen = () => document.getElementById('dot').classList.remove('dead');
es.onerror = () => document.getElementById('dot').classList.add('dead');

es.addEventListener('status', e => applyStatus(JSON.parse(e.data)));
es.addEventListener('mailbox-msg', e => addMailMsg(JSON.parse(e.data)));
es.addEventListener('llm-call', e => {
  const d = JSON.parse(e.data);
  updateUsageBar(d.missionTotalUsd);
  addLlmCallToUsage(d);
});
es.addEventListener('step-paused', () => {
  stepWaiting = true; renderStepBtn();
});
es.addEventListener('step-resumed', () => {
  stepWaiting = false; renderStepBtn();
});
es.addEventListener('mental-map-update', e => {
  const d = JSON.parse(e.data);
  if (d.agentId === activeAgent && activeSubTab === 'mm') renderMentalMap(d.html);
});
es.addEventListener('conversation-update', e => {
  const d = JSON.parse(e.data);
  if (d.agentId === activeAgent && activeSubTab === 'cv') appendConvMsg(d.message);
});
es.addEventListener('shutdown', e => {
  const d = JSON.parse(e.data);
  document.getElementById('dot').classList.add('dead');
  document.getElementById('stop-btn').disabled = true;
  document.getElementById('stop-btn').textContent = '— stopped';
  addSysMsg('Daemon stopped: ' + (d.reason || 'unknown'));
  stopped = true;
});
es.addEventListener('started', () => setStarted(true));
es.addEventListener('cost-limit', () => {
  document.getElementById('hcost').classList.add('danger');
  addSysMsg('⚠ Cost limit reached — daemon aborting');
});

// ── Status ───────────────────────────────────────────────────────────
function applyStatus(s) {
  document.getElementById('hname').textContent = s.missionName || s.missionId;
  document.getElementById('hmeta').textContent = s.model;
  startedAt = Date.now() - s.uptimeSec * 1000;
  maxCostUsd = s.maxCostUsd;
  stepEnabled = s.stepEnabled;
  if (s.started) setStarted(true);
  renderStepBtn();
  updateCostDisplay(s.missionTotalUsd, s.maxCostUsd);
  updateUsageTable(s.agents, s.missionTotalUsd, s.maxCostUsd);
}

function setStarted(val) {
  missionStarted = val;
  const btn = document.getElementById('start-btn');
  if (val) {
    btn.textContent = '● Running';
    btn.className = 'btn btn-start running';
    btn.disabled = true;
  }
}

function updateCostDisplay(total, max) {
  const el = document.getElementById('hcost');
  el.textContent = '$' + total.toFixed(4);
  el.className = 'hcost';
  if (max && total > max * 0.8) el.classList.add('warn');
  if (max && total >= max)      el.classList.add('danger');
}

// ── Usage bar ────────────────────────────────────────────────────────
const agentCosts = {};
function addLlmCallToUsage(d) {
  agentCosts[d.agentId] = d.agentTotalUsd;
  updateCostDisplay(d.missionTotalUsd, maxCostUsd);
  const row = document.getElementById('usage-row');
  row.innerHTML = Object.entries(agentCosts)
    .sort((a,b) => b[1] - a[1])
    .map(([id, cost]) => \`<span><span class="u-agent ac-\${id}">\${id}</span> <span class="u-val">$\${cost.toFixed(4)}</span></span>\`)
    .join('') + \`<span class="u-total">mission $\${d.missionTotalUsd.toFixed(4)}</span>\`;
  if (maxCostUsd) {
    document.getElementById('cap-wrap').style.display = 'block';
    const pct = Math.min(100, (d.missionTotalUsd / maxCostUsd) * 100);
    const fill = document.getElementById('cap-fill');
    fill.style.width = pct + '%';
    fill.style.background = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--yellow)' : 'var(--accent)';
  }
}
function updateUsageTable(agents) {
  if (!agents?.length) return;
  agents.forEach(a => agentCosts[a.agentId] = a.costUsd);
  const total = agents.reduce((s,a) => s+a.costUsd, 0);
  updateCostDisplay(total, maxCostUsd);
  const row = document.getElementById('usage-row');
  row.innerHTML = agents
    .map(a => \`<span><span class="u-agent ac-\${a.agentId}">\${a.agentId}</span> <span class="u-val">$\${a.costUsd.toFixed(4)}</span></span>\`)
    .join('') + \`<span class="u-total">mission $\${total.toFixed(4)}</span>\`;
}
function updateUsageBar(total) { updateCostDisplay(total, maxCostUsd); }

// ── Feed ─────────────────────────────────────────────────────────────
function addMailMsg(m) {
  const feed = document.getElementById('feed');
  feed.querySelector('.empty-state')?.remove();
  const div = document.createElement('div');
  div.className = \`msg ab-\${m.from}\`;
  div.innerHTML =
    \`<div class="msg-hdr">
       <span class="msg-from ac-\${m.from}">\${esc(m.from)}</span>
       <span class="msg-to">→ \${esc(m.to.join(', '))}</span>
       <span class="msg-time">\${fmtTime(m.timestamp)}</span>
     </div>
     <div class="msg-subj">\${esc(m.subject)}</div>
     <div class="msg-body">\${esc(m.bodyPreview)}</div>\`;
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

function addSysMsg(text) {
  const feed = document.getElementById('feed');
  feed.querySelector('.empty-state')?.remove();
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = \`<div class="msg-sys">\${esc(text)}</div>\`;
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

// ── Agent detail ─────────────────────────────────────────────────────
function selectAgent(id) {
  activeAgent = id;
  document.querySelectorAll('.agent-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.id === id);
  });
  loadDetail();
}

function selectSubTab(tab) {
  activeSubTab = tab;
  document.getElementById('st-mm').classList.toggle('active', tab === 'mm');
  document.getElementById('st-cv').classList.toggle('active', tab === 'cv');
  loadDetail();
}

async function loadDetail() {
  if (!activeAgent) return;
  const pane = document.getElementById('detail-pane');
  pane.innerHTML = '<div class="empty-state">Loading…</div>';
  if (activeSubTab === 'mm') {
    const r = await fetch(\`/agents/\${activeAgent}/mental-map\`);
    const { html } = await r.json();
    renderMentalMap(html);
  } else {
    const r = await fetch(\`/agents/\${activeAgent}/conversation\`);
    const msgs = await r.json();
    pane.innerHTML = '';
    if (!msgs.length) { pane.innerHTML = '<div class="empty-state">No conversation yet</div>'; return; }
    msgs.forEach(m => appendConvMsg(m, false));
    pane.scrollTop = pane.scrollHeight;
  }
}

function renderMentalMap(html) {
  const pane = document.getElementById('detail-pane');
  if (!html) { pane.innerHTML = '<div class="empty-state">Mental map is empty</div>'; return; }
  const div = document.createElement('div');
  div.className = 'mental-map-html';
  div.innerHTML = html;
  pane.innerHTML = '';
  pane.appendChild(div);
}

function appendConvMsg(m, scroll = true) {
  const pane = document.getElementById('detail-pane');
  pane.querySelector('.empty-state')?.remove();
  const div = document.createElement('div');
  if (m.role === 'user') {
    div.className = 'conv-msg conv-user';
    const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    div.innerHTML = \`<div class="conv-role">USER (task)</div><div class="conv-text">\${esc(body.slice(0,800))}</div>\`;
  } else if (m.role === 'assistant') {
    div.className = 'conv-msg conv-assistant';
    let html = '<div class="conv-role">ASSISTANT</div>';
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text?.trim())
        html += \`<div class="conv-text">\${esc(b.text.slice(0,600))}</div>\`;
      else if (b.type === 'toolCall')
        html += \`<div class="conv-tool">→ \${esc(b.name)}(\${esc(JSON.stringify(b.arguments).slice(0,120))})</div>\`;
    }
    div.innerHTML = html;
  } else if (m.role === 'toolResult') {
    div.className = 'conv-msg conv-toolResult';
    const text = (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('').slice(0, 300);
    div.innerHTML = \`<div class="conv-role \${m.isError ? 'conv-err' : 'conv-result'}">← \${esc(m.toolName)}</div><div class="conv-text">\${esc(text)}</div>\`;
  } else {
    return;
  }
  pane.appendChild(div);
  if (scroll) pane.scrollTop = pane.scrollHeight;
}

// ── Buttons ───────────────────────────────────────────────────────────
function renderStepBtn() {
  const btn = document.getElementById('step-btn');
  const adv = document.getElementById('advance-btn');
  if (stepWaiting) {
    btn.textContent = 'Step: ON';
    btn.className = 'btn btn-step on';
    adv.style.display = '';
    adv.disabled = false;
    adv.className = 'btn btn-step waiting';
    adv.textContent = '▶ Advance';
  } else if (stepEnabled) {
    btn.textContent = 'Step: ON';
    btn.className = 'btn btn-step on';
    adv.style.display = '';
    adv.disabled = true;
    adv.className = 'btn btn-step';
  } else {
    btn.textContent = 'Step: OFF';
    btn.className = 'btn btn-step';
    adv.style.display = 'none';
  }
}

async function startMission() {
  if (missionStarted) return;
  await fetch('/start', {method:'POST'});
  setStarted(true);
}

async function toggleStep() {
  const r = await fetch('/toggle-step', {method:'POST'});
  const d = await r.json();
  stepEnabled = d.stepEnabled;
  renderStepBtn();
}

async function advance() {
  await fetch('/step', {method:'POST'});
}

function stopDaemon() {
  if (stopped) return;
  if (!confirm('Stop the MAGI daemon? This will abort the current mission cycle.')) return;
  fetch('/stop', {method:'POST'}).catch(()=>{});
  document.getElementById('stop-btn').disabled = true;
  document.getElementById('stop-btn').textContent = 'Stopping…';
}

// ── Compose ───────────────────────────────────────────────────────────
function openCompose() {
  document.getElementById('compose-overlay').classList.remove('hidden');
  document.getElementById('compose-body').focus();
}
function closeCompose() {
  document.getElementById('compose-overlay').classList.add('hidden');
}
function closeComposeIfBg(e) {
  if (e.target === document.getElementById('compose-overlay')) closeCompose();
}
function checkAll() {
  document.querySelectorAll('#to-checks input[type=checkbox]').forEach(c => c.checked = true);
}
async function sendMessage() {
  const to = [...document.querySelectorAll('#to-checks input:checked')].map(c => c.value);
  const subject = document.getElementById('compose-subject').value.trim();
  const message = document.getElementById('compose-body').value.trim();
  if (!to.length) { alert('Select at least one recipient'); return; }
  if (!message)   { alert('Message body is required'); return; }
  const r = await fetch('/send-message', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({to, subject, message})
  });
  if (r.ok) {
    closeCompose();
    document.getElementById('compose-body').value = '';
    document.getElementById('compose-subject').value = '';
    document.querySelectorAll('#to-checks input').forEach(c => c.checked = false);
  }
}

// ── Uptime ────────────────────────────────────────────────────────────
setInterval(() => {
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  document.getElementById('hup').textContent =
    h > 0 ? \`\${h}h \${m}m\` : m > 0 ? \`\${m}m \${s}s\` : \`\${s}s\`;
}, 1000);

// ── Utilities ─────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
}
</script>
</body>
</html>`;
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}
