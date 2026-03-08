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
	| "agent-status"
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

export interface PlaybookEntry {
	title: string;
	to: string[];
	subject: string;
	body: string;
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

	// Agent queue state
	private runningAgent: string | null = null;
	private pendingAgents: string[] = [];

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
		private readonly playbook: PlaybookEntry[] = [],
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

	/** Called by the orchestrator before each agent turn. */
	notifyAgentStart(agentId: string, pending: string[]): void {
		this.runningAgent = agentId;
		this.pendingAgents = pending;
		this.push("agent-status", { running: agentId, pending });
	}

	/** Called by the orchestrator after each agent turn. */
	notifyAgentDone(_agentId: string): void {
		this.runningAgent = null;
		this.push("agent-status", { running: null, pending: this.pendingAgents });
	}

	/** Called when the cycle ends and the loop goes idle. */
	notifyIdle(): void {
		this.runningAgent = null;
		this.pendingAgents = [];
		this.push("agent-status", { running: null, pending: [] });
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
			running: this.runningAgent,
			pending: this.pendingAgents,
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
		const playbookJson = JSON.stringify(this.playbook);
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
.btn-step-toggle { border-color:var(--border);color:var(--muted); }
.btn-step-toggle.on { border-color:var(--accent);color:var(--accent); }
.btn-stop   { border-color:var(--red);color:var(--red); }
/* Queue strip */
.queue-strip { background:var(--surface);border-bottom:1px solid var(--border);
               padding:4px 14px;display:flex;align-items:center;gap:8px;
               font-size:11px;flex-shrink:0;min-height:30px; }
.q-idle      { color:var(--muted);font-style:italic; }
.q-agent     { display:flex;align-items:center;gap:4px;border-radius:3px;
               padding:2px 6px;background:#21262d; }
.q-agent.running { background:var(--accent);color:#000;font-weight:600; }
.q-agent.running::before { content:'▶ '; }
.q-arrow     { color:var(--border); }
.btn-run     { background:var(--green);border:none;color:#000;font-weight:600;
               border-radius:4px;padding:3px 12px;font:11px/1.4 monospace;
               cursor:pointer;animation:pulse .9s infinite; }
.btn-run:hover { opacity:.85; }

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
/* ── Conversation chat bubbles ── */
.conv-turn-hdr { text-align:center;font-size:10px;color:var(--muted);
                 margin:10px 0 6px;letter-spacing:.05em; }
.conv-bubble { display:flex;gap:8px;margin-bottom:8px;align-items:flex-start; }
.conv-avatar { width:26px;height:26px;border-radius:50%;display:flex;align-items:center;
               justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;margin-top:1px; }
.av-user     { background:var(--c-user);color:#000; }
.av-agent    { background:var(--accent);color:#000;font-size:9px; }
.av-think    { background:var(--surface);border:1px solid var(--border);font-size:12px; }
.conv-body   { flex:1;min-width:0; }
.conv-label  { font-size:10px;color:var(--muted);margin-bottom:2px; }
.conv-text   { font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word;
               background:var(--surface);border:1px solid var(--border);
               border-radius:5px;padding:7px 9px; }
.conv-bubble-user  .conv-text { border-left:3px solid var(--c-user); }
.conv-bubble-agent .conv-text { border-left:3px solid var(--accent); }
.conv-think-text { color:var(--muted);font-style:italic; }
/* Tool boxes */
.conv-tool-box  { margin:3px 0 8px 34px;border:1px solid var(--border);
                  border-radius:5px;overflow:hidden;font-size:11px; }
.conv-tool-hdr  { display:flex;align-items:center;gap:6px;padding:5px 9px;
                  background:#161f16;cursor:pointer;user-select:none; }
.conv-tool-hdr:hover { background:#1c281c; }
.conv-tool-icon { font-size:12px;flex-shrink:0; }
.conv-tool-name { flex:1;font-weight:600;color:var(--yellow); }
.conv-tool-arrow{ color:var(--muted);font-size:9px; }
.conv-tool-body { display:none; }
.conv-tool-body.open { display:block; }
.conv-tool-args { padding:6px 9px;background:#0d1117;color:var(--muted);
                  white-space:pre-wrap;word-break:break-word;
                  max-height:120px;overflow-y:auto;border-bottom:1px solid var(--border); }
.conv-tool-result { padding:6px 9px;white-space:pre-wrap;word-break:break-word;
                    max-height:200px;overflow-y:auto; }
.conv-tool-result.ok      { color:#3fb950; }
.conv-tool-result.err     { color:var(--red); }
.conv-tool-result.pending { color:var(--muted);font-style:italic; }

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

/* ── Playbook ── */
.pb-item { background:var(--surface);border:1px solid var(--border);border-radius:6px;
           padding:11px 13px;margin-bottom:8px;cursor:pointer; }
.pb-item:hover { border-color:var(--accent); }
.pb-item.sent { opacity:.5; }
.pb-title { font-weight:600;font-size:12px;margin-bottom:4px;color:var(--text); }
.pb-meta  { font-size:11px;color:var(--muted);margin-bottom:6px; }
.pb-preview { font-size:11px;color:var(--muted);white-space:pre-wrap;
              max-height:48px;overflow:hidden;word-break:break-word; }
.pb-actions { display:flex;gap:6px;margin-top:8px; }
.pb-edit { font-size:11px;padding:3px 9px; }
.pb-sent-badge { font-size:10px;color:var(--green);margin-left:auto;align-self:center; }
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
  <button class="btn btn-step-toggle" id="step-btn" onclick="toggleStep()">Step ○</button>
  <button class="btn btn-stop" id="stop-btn" onclick="stopDaemon()">■ Stop</button>
</header>

<div class="queue-strip" id="queue-strip">
  <span class="q-idle">Idle — waiting for messages</span>
</div>

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
      <div class="agent-tab" id="tab-playbook" onclick="selectPlaybook()" style="color:var(--accent)">📋 Playbook</div>
    </div>
    <div class="sub-tabs" id="sub-tabs-bar">
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
const PLAYBOOK = ${playbookJson};
const es = new EventSource('/events');
let activeAgent = null;
let activeSubTab = 'mm';
let missionStarted = false;
let stepEnabled = false;
let stepWaiting = false;
let runningAgent = null;
let pendingAgents = [];
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
es.addEventListener('agent-status', e => {
  const d = JSON.parse(e.data);
  runningAgent = d.running;
  pendingAgents = d.pending ?? [];
  renderQueue();
  renderAgentTabIndicators();
});
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
  runningAgent = s.running ?? null;
  pendingAgents = s.pending ?? [];
  if (s.started) setStarted(true);
  renderStepBtn();
  renderQueue();
  renderAgentTabIndicators();
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
  convToolBoxes.clear(); convLastTurn = -1;
  document.querySelectorAll('.agent-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.id === id);
  });
  document.getElementById('tab-playbook').classList.remove('active');
  document.getElementById('sub-tabs-bar').style.display = '';
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
    const docs = await r.json();
    renderConversation(docs);
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

// toolCallId → result-slot DOM element; keyed per agent to survive tab switches
const convToolBoxes = new Map();
let convLastTurn = -1;

function renderConversation(docs) {
  const pane = document.getElementById('detail-pane');
  pane.innerHTML = '';
  convToolBoxes.clear();
  convLastTurn = -1;
  if (!docs.length) {
    pane.innerHTML = '<div class="empty-state">No conversation yet</div>';
    return;
  }
  for (const doc of docs) _renderDoc(doc, pane);
  pane.scrollTop = pane.scrollHeight;
}

function appendConvMsg(doc, scroll = true) {
  const pane = document.getElementById('detail-pane');
  pane.querySelector('.empty-state')?.remove();
  _renderDoc(doc, pane);
  if (scroll) pane.scrollTop = pane.scrollHeight;
}

function _renderDoc(doc, pane) {
  const m = doc.message;
  if (!m) return;
  const turn = doc.turnNumber ?? 0;
  const agentId = doc.agentId ?? activeAgent ?? '';

  // Turn divider
  if (turn !== convLastTurn) {
    convLastTurn = turn;
    const hdr = document.createElement('div');
    hdr.className = 'conv-turn-hdr';
    hdr.textContent = \`— Turn \${turn} —\`;
    pane.appendChild(hdr);
  }

  if (m.role === 'user') {
    const content = typeof m.content === 'string'
      ? m.content
      : (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('\\n');
    const el = document.createElement('div');
    el.className = 'conv-bubble conv-bubble-user';
    el.innerHTML =
      \`<div class="conv-avatar av-user">📨</div>
       <div class="conv-body">
         <div class="conv-label">Operator / Mailbox</div>
         <div class="conv-text">\${esc(content)}</div>
       </div>\`;
    pane.appendChild(el);

  } else if (m.role === 'assistant') {
    const blocks = Array.isArray(m.content) ? m.content : [];
    const thinking = blocks.filter(b => b.type === 'thinking' && b.thinking?.trim());
    const texts    = blocks.filter(b => b.type === 'text'    && b.text?.trim());
    const calls    = blocks.filter(b => b.type === 'toolCall');

    if (thinking.length) {
      const el = document.createElement('div');
      el.className = 'conv-bubble';
      const full = thinking.map(b => b.thinking).join('\\n\\n');
      el.innerHTML =
        \`<div class="conv-avatar av-think">💭</div>
         <div class="conv-body">
           <div class="conv-label">Thinking</div>
           <div class="conv-text conv-think-text">\${esc(full.slice(0,600))}\${full.length>600?'…':''}</div>
         </div>\`;
      pane.appendChild(el);
    }
    if (texts.length) {
      const el = document.createElement('div');
      el.className = 'conv-bubble conv-bubble-agent';
      el.innerHTML =
        \`<div class="conv-avatar av-agent">AI</div>
         <div class="conv-body">
           <div class="conv-text">\${esc(texts.map(b=>b.text).join('\\n\\n'))}</div>
         </div>\`;
      pane.appendChild(el);
    }
    for (const call of calls) {
      const { el, resultEl } = _makeToolBox(call.name, call.arguments);
      pane.appendChild(el);
      convToolBoxes.set(agentId + ':' + call.id, resultEl);
    }

  } else if (m.role === 'toolResult') {
    const slot = convToolBoxes.get(agentId + ':' + m.toolCallId);
    if (slot) {
      _fillResult(slot, m);
    } else {
      // Orphaned result (e.g. page reload mid-turn) — show as standalone box
      const el = document.createElement('div');
      el.className = 'conv-tool-box';
      const txt = (m.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').slice(0,500);
      el.innerHTML =
        \`<div class="conv-tool-hdr" onclick="toggleToolBox(this)">
           <span class="conv-tool-icon">\${_toolIcon(m.toolName)}</span>
           <span class="conv-tool-name">\${esc(m.toolName)}</span>
           <span class="conv-tool-arrow">▼</span>
         </div>
         <div class="conv-tool-body open">
           <div class="conv-tool-result \${m.isError?'err':'ok'}">\${esc(txt)}</div>
         </div>\`;
      pane.appendChild(el);
    }
  }
}

function _makeToolBox(name, args) {
  const el = document.createElement('div');
  el.className = 'conv-tool-box';
  const argsStr = JSON.stringify(args, null, 2);
  el.innerHTML =
    \`<div class="conv-tool-hdr" onclick="toggleToolBox(this)">
       <span class="conv-tool-icon">\${_toolIcon(name)}</span>
       <span class="conv-tool-name">\${esc(name)}</span>
       <span class="conv-tool-arrow">▼</span>
     </div>
     <div class="conv-tool-body open">
       <div class="conv-tool-args">\${esc(argsStr)}</div>
       <div class="conv-tool-result pending">⏳ running…</div>
     </div>\`;
  const resultEl = el.querySelector('.conv-tool-result');
  return { el, resultEl };
}

function _fillResult(el, m) {
  const txt = (m.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  el.className = 'conv-tool-result ' + (m.isError ? 'err' : 'ok');
  el.textContent = txt.slice(0, 1000) + (txt.length > 1000 ? '…' : '');
}

function toggleToolBox(hdr) {
  const body = hdr.nextElementSibling;
  const arrow = hdr.querySelector('.conv-tool-arrow');
  const open = body.classList.toggle('open');
  arrow.textContent = open ? '▼' : '▶';
}

function _toolIcon(name) {
  return ({Bash:'⚙',WriteFile:'✍',EditFile:'✏',PostMessage:'✉',
    UpdateMentalMap:'🧠',FetchUrl:'🌐',BrowseWeb:'🌐',SearchWeb:'🔍',
    InspectImage:'🖼',ListTeam:'👥',ListMessages:'📬',ReadMessage:'📨'})[name] || '🔧';
}

// ── Step button ───────────────────────────────────────────────────────
function renderStepBtn() {
  const btn = document.getElementById('step-btn');
  if (stepEnabled) {
    btn.textContent = 'Step ●';
    btn.className = 'btn btn-step-toggle on';
  } else {
    btn.textContent = 'Step ○';
    btn.className = 'btn btn-step-toggle';
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
  if (!stepEnabled) stepWaiting = false;
  renderStepBtn();
  renderQueue();
}

async function advanceStep() {
  await fetch('/step', {method:'POST'});
}

// ── Queue strip ───────────────────────────────────────────────────────
function renderQueue() {
  const strip = document.getElementById('queue-strip');
  if (!strip) return;

  if (stepEnabled && stepWaiting && runningAgent) {
    const name = agentDisplayName(runningAgent);
    let html = '<button class="btn-run" onclick="advanceStep()">&#9654; Run ' + esc(name) + '</button>';
    pendingAgents.forEach(function(id) {
      html += '<span class="q-arrow">&rarr;</span><span class="q-agent">' + esc(agentDisplayName(id)) + '</span>';
    });
    strip.innerHTML = html;
    return;
  }

  if (runningAgent) {
    let html = '<span class="q-agent running">' + esc(agentDisplayName(runningAgent)) + '</span>';
    pendingAgents.forEach(function(id) {
      html += '<span class="q-arrow">&rarr;</span><span class="q-agent">' + esc(agentDisplayName(id)) + '</span>';
    });
    strip.innerHTML = html;
    return;
  }

  strip.innerHTML = '<span class="q-idle">Idle \u2014 waiting for messages</span>';
}

function agentDisplayName(id) {
  const a = AGENTS.find(function(a) { return a.id === id; });
  return a ? a.name : id;
}

function renderAgentTabIndicators() {
  document.querySelectorAll('.agent-tab[data-id]').forEach(function(tab) {
    const id = tab.dataset.id;
    const base = tab.dataset.baseName || tab.textContent.replace(/^\u25b6 /, '');
    tab.dataset.baseName = base;
    tab.textContent = (id === runningAgent) ? '\u25b6 ' + base : base;
  });
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

// ── Playbook ──────────────────────────────────────────────────────────
const playbookSent = new Set();

function selectPlaybook() {
  // Deselect agent tabs
  activeAgent = null;
  document.querySelectorAll('.agent-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-playbook').classList.add('active');
  document.getElementById('sub-tabs-bar').style.display = 'none';
  renderPlaybook();
}

function renderPlaybook() {
  const pane = document.getElementById('detail-pane');
  if (!PLAYBOOK.length) {
    pane.innerHTML = '<div class="empty-state">No playbook messages defined</div>';
    return;
  }
  pane.innerHTML = '';
  PLAYBOOK.forEach((entry, i) => {
    const sent = playbookSent.has(i);
    const div = document.createElement('div');
    div.className = 'pb-item' + (sent ? ' sent' : '');
    div.innerHTML =
      \`<div class="pb-title">\${esc(entry.title)}</div>
       <div class="pb-meta">To: \${entry.to.map(t => \`<span class="ac-\${t}">\${t}</span>\`).join(', ')}</div>
       <div class="pb-preview">\${esc(entry.body.slice(0, 200))}\${entry.body.length > 200 ? '…' : ''}</div>
       <div class="pb-actions">
         <button class="btn pb-edit" onclick="editPlaybookEntry(\${i})">✏ Edit & Send</button>
         \${sent ? '<span class="pb-sent-badge">✓ sent</span>' : ''}
       </div>\`;
    pane.appendChild(div);
  });
}

function editPlaybookEntry(i) {
  const entry = PLAYBOOK[i];
  if (!entry) return;
  // Pre-fill compose modal
  document.querySelectorAll('#to-checks input[type=checkbox]').forEach(c => {
    c.checked = entry.to.includes(c.value);
  });
  document.getElementById('compose-subject').value = entry.subject;
  document.getElementById('compose-body').value = entry.body;
  // Store index so sendMessage() can mark it sent
  document.getElementById('compose-overlay').dataset.playbookIdx = String(i);
  document.getElementById('compose-overlay').classList.remove('hidden');
  document.getElementById('compose-body').focus();
}

// Override closeCompose to clear playbook index
const _origCloseCompose = closeCompose;
closeCompose = function() {
  delete document.getElementById('compose-overlay').dataset.playbookIdx;
  _origCloseCompose();
};

// Patch sendMessage to mark playbook entry sent
const _origSendMessage = sendMessage;
sendMessage = async function() {
  const idx = document.getElementById('compose-overlay').dataset.playbookIdx;
  await _origSendMessage();
  if (idx !== undefined) {
    playbookSent.add(Number(idx));
    if (activeAgent === null) renderPlaybook(); // refresh if playbook tab active
  }
};

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
