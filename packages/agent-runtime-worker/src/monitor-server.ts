import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Db } from "mongodb";
import { MAILBOX_MAX_BODY_BYTES, type MailboxRepository } from "./mailbox.js";
import type { UsageAccumulator } from "./usage.js";

// Resolved once at module load; public/ lives next to the compiled JS.
const PUBLIC_DIR = join(
	fileURLToPath(new URL(".", import.meta.url)),
	"public",
);

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css",
	".js": "application/javascript",
};

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

		// ── Static files (/, /index.html, /style.css, /app.js)
		if (url === "/" || url === "/index.html") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(readFileSync(join(PUBLIC_DIR, "index.html")));
			return;
		}
		if (url === "/style.css" || url === "/app.js") {
			const ext = url.slice(url.lastIndexOf(".")) as keyof typeof MIME;
			res.writeHead(200, { "Content-Type": MIME[ext] });
			res.end(readFileSync(join(PUBLIC_DIR, url)));
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

		// ── GET /playbook
		if (url === "/playbook" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(this.playbook));
			return;
		}

		// ── GET /status
		if (url === "/status" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(this.statusPayload()));
			return;
		}

		// ── GET /mailbox
		if (url === "/mailbox" && req.method === "GET") {
			const msgs = await this.db
				.collection("mailbox")
				.find({ missionId: this.missionId })
				.sort({ timestamp: 1 })
				.limit(500)
				.toArray();
			const payload = msgs.map((doc) => {
				const d = doc as {
					_id: unknown;
					from: string;
					to: string[];
					subject: string;
					body: string;
					timestamp?: Date;
				};
				return {
					id: String(d._id),
					from: d.from,
					to: d.to,
					subject: d.subject,
					bodyPreview:
						d.body.length > 400 ? `${d.body.slice(0, 400)}…` : d.body,
					body: d.body,
					timestamp: (d.timestamp ?? new Date()).toISOString(),
				};
			});
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(payload));
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
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid JSON" }));
				return;
			}
			const { to, subject, message } = parsed as Record<string, unknown>;
			if (
				!Array.isArray(to) ||
				to.length === 0 ||
				!to.every((r) => typeof r === "string") ||
				typeof subject !== "string" ||
				typeof message !== "string" ||
				message.trim() === ""
			) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: "to (non-empty string[]), subject (string), and message (string) are required",
					}),
				);
				return;
			}
			await this.mailboxRepo.post({
				missionId: this.missionId,
				from: "user",
				to: to as string[],
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
		let backoffMs = 1_000;
		while (true) {
			try {
				await new Promise<void>((resolve, reject) => {
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
							body: doc.body,
							timestamp: (doc.timestamp ?? new Date()).toISOString(),
						});
						this.push("status", this.statusPayload());
					});
					stream.on("error", (e) => {
						stream.close().catch(() => {});
						reject(e);
					});
					// Resolve only when the server itself closes (stream persists indefinitely).
					this.server.once("close", () => {
						stream.close().catch(() => {});
						resolve();
					});
				});
				return; // server closed — stop watching
			} catch (e) {
				console.error(
					`[monitor] Mailbox watch error: ${(e as Error).message}. Retrying in ${backoffMs}ms`,
				);
				await new Promise<void>((res) => setTimeout(res, backoffMs));
				backoffMs = Math.min(backoffMs * 2, 30_000);
			}
		}
	}

	private async watchConversations(): Promise<void> {
		let backoffMs = 1_000;
		while (true) {
			try {
				await new Promise<void>((resolve, reject) => {
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
					stream.on("error", (e) => {
						stream.close().catch(() => {});
						reject(e);
					});
					this.server.once("close", () => {
						stream.close().catch(() => {});
						resolve();
					});
				});
				return;
			} catch (e) {
				console.error(
					`[monitor] Conversation watch error: ${(e as Error).message}. Retrying in ${backoffMs}ms`,
				);
				await new Promise<void>((res) => setTimeout(res, backoffMs));
				backoffMs = Math.min(backoffMs * 2, 30_000);
			}
		}
	}

	private async watchMentalMaps(): Promise<void> {
		const agentIds = this.agents.map((a) => a.id);
		let backoffMs = 1_000;
		while (true) {
			try {
				await new Promise<void>((resolve, reject) => {
					const stream = this.db
						.collection("mental_maps")
						.watch(
							[{ $match: { "fullDocument.agentId": { $in: agentIds } } }],
							{ fullDocument: "updateLookup" },
						);
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
					stream.on("error", (e) => {
						stream.close().catch(() => {});
						reject(e);
					});
					this.server.once("close", () => {
						stream.close().catch(() => {});
						resolve();
					});
				});
				return;
			} catch (e) {
				console.error(
					`[monitor] Mental map watch error: ${(e as Error).message}. Retrying in ${backoffMs}ms`,
				);
				await new Promise<void>((res) => setTimeout(res, backoffMs));
				backoffMs = Math.min(backoffMs * 2, 30_000);
			}
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

}

// ── Helpers ───────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = MAILBOX_MAX_BODY_BYTES;

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		let bytes = 0;
		req.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_BODY_BYTES) {
				req.destroy();
				reject(new Error("Request body too large"));
				return;
			}
			data += chunk;
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}
