import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "mongodb";
import { MAILBOX_MAX_BODY_BYTES, type MailboxRepository } from "./mailbox.js";
import type { UsageAccumulator } from "./usage.js";

// Default public/ dir: next to the compiled JS (dist/public/).
// Tests running from src/ via Vitest pass an explicit publicDir to the constructor.
const DEFAULT_PUBLIC_DIR = join(
	fileURLToPath(new URL(".", import.meta.url)),
	"public",
);

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css",
	".js": "application/javascript",
};

const TEXT_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".json",
	".yaml",
	".yml",
	".toml",
	".ts",
	".js",
	".mjs",
	".py",
	".sh",
	".bash",
	".env",
	".csv",
	".log",
	".xml",
	".html",
	".css",
	".sql",
	".r",
]);

const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".ico": "image/x-icon",
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
	| "cost-pause"
	| "cost-resumed"
	| "status"
	| "started"
	| "agent-error"
	| "limit-alert"
	| "agent-paused"
	| "agent-resumed";

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
 *   GET    /                              HTML dashboard
 *   GET    /events                        SSE stream
 *   GET    /team                          JSON agent roster
 *   GET    /status                        JSON usage + mission info
 *   GET    /log?lines=N                   tail of daemon.log
 *   GET    /mailbox                       recent mailbox messages
 *   GET    /schedule                      pending scheduled wakeups
 *   GET    /agents/:id/mental-map         current mental map HTML
 *   GET    /agents/:id/sessions           session metadata (aggregated)
 *   GET    /agents/:id/sessions/:turn     session detail (one turn)
 *   GET    /agents/:id/usage              llmCallLog entries for agent
 *   GET    /files/shared?path=            browse / read sharedDir
 *   GET    /files/workdir/:id?path=       browse / read agent workdir
 *   POST   /files/shared/write            write a file to sharedDir (copilot)
 *   POST   /files/workdir/:id/write       write a file to agent workdir (copilot)
 *   DELETE /schedule/:id                  cancel a scheduled message
 *   POST   /send-message                  inject a mailbox message
 *   POST   /step                          advance one step
 *   POST   /toggle-step                   enable / disable step mode
 *   POST   /extend-budget                 add USD to spending cap
 *   POST   /start                         unblock waitForStart
 *   POST   /stop                          graceful daemon shutdown
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

	// Concurrent agent tracking
	private runningAgents = new Set<string>();

	// Budget pause gate
	private budgetPaused = false;
	private budgetResolve: (() => void) | null = null;
	private currentCapUsd: number | null;
	/** Callback so daemon.ts can update its local maxCostUsd when the cap is changed. */
	onBudgetExtended?: (newCapUsd: number) => void;

	// Per-agent pause gate (copilot/operator intervention). Agents in this set are
	// skipped by the orchestrator at the next dispatch boundary until resumed.
	private readonly pausedAgents = new Set<string>();

	/** Read by the orchestrator's isAgentPaused hook before dispatching an agent. */
	isAgentPaused(agentId: string): boolean {
		return this.pausedAgents.has(agentId);
	}

	// Agent workdir map (populated by daemon after workspace provision)
	private agentWorkdirs = new Map<string, string>();

	// Per-machine auth token for mutating routes.
	// Set via MONITOR_TOKEN env var at machine creation time.
	// Empty/absent = local dev mode: no check performed.
	private readonly monitorToken = process.env.MONITOR_TOKEN ?? "";

	constructor(
		private readonly db: Db,
		private readonly missionId: string,
		private readonly missionName: string,
		private readonly model: string,
		private readonly accumulator: UsageAccumulator,
		private readonly mailboxRepo: MailboxRepository,
		private readonly agents: AgentInfo[],
		private readonly onStop: () => void,
		maxCostUsd: number | null,
		private readonly startedAt = new Date(),
		private readonly workdir: string = process.cwd(),
		private readonly sharedDir: string = process.cwd(),
		private readonly cancelSchedule?: (id: string) => Promise<void>,
		private readonly publicDir: string = DEFAULT_PUBLIC_DIR,
	) {
		this.currentCapUsd = maxCostUsd;
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

	/** Register agent workdir paths after workspace provisioning. */
	setAgentWorkdirs(map: Map<string, string>): void {
		this.agentWorkdirs = map;
	}

	/** Called by the orchestrator when an agent is dispatched. */
	notifyAgentStart(agentId: string): void {
		this.runningAgents.add(agentId);
		this.push("agent-status", { running: [...this.runningAgents] });
	}

	/** Called by the orchestrator after each agent turn. */
	notifyAgentDone(agentId: string): void {
		this.runningAgents.delete(agentId);
		this.push("agent-status", { running: [...this.runningAgents] });
	}

	/** Called when the loop goes idle (no agents running, no unread mail). */
	notifyIdle(): void {
		this.runningAgents.clear();
		this.push("agent-status", { running: [] });
	}

	/**
	 * Called by the daemon when the spending cap is reached.
	 * Pushes `cost-pause` to all clients and sets the paused flag.
	 */
	notifyCostPause(spentUsd: number, capUsd: number): void {
		this.budgetPaused = true;
		console.warn(
			`[monitor] Budget cap $${capUsd.toFixed(2)} reached ($${spentUsd.toFixed(4)} spent) — pausing`,
		);
		this.push("cost-pause", { spentUsd, capUsd, budgetPaused: true });
		this.push("status", this.statusPayload());
	}

	/**
	 * Called by the orchestrator after each agent turn via the waitForBudget hook.
	 * Resolves immediately when not paused; blocks until operator extends budget.
	 */
	waitForBudget(): Promise<void> {
		if (!this.budgetPaused) return Promise.resolve();
		return new Promise((resolve) => {
			this.budgetResolve = resolve;
		});
	}

	/** Blocks until the operator clicks Start in the dashboard. */
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

	/** Called by the agent runner when the mental map changes. */
	notifyMentalMapUpdate(agentId: string, html: string): void {
		this.push("mental-map-update", { agentId, html });
	}

	async start(port: number): Promise<void> {
		void this.watchMailbox();
		void this.watchConversations();

		await new Promise<void>((resolve, reject) => {
			// Bind to :: (all interfaces, dual-stack) so the Fly.io WireGuard proxy
			// can reach port 4000 via the machine's fdaa: IPv6 address.
			this.server.listen(port, "::", () => resolve());
			this.server.once("error", reject);
		});
		console.log(`[monitor] Dashboard: http://localhost:${port}`);
	}

	stop(): void {
		// Resolve all blocked waitFor* promises so the orchestration loop can
		// reach its finally block before the process exits.
		this.startResolve?.();
		this.budgetResolve?.();
		this.stepResolve?.();

		for (const client of this.clients) {
			try {
				client.socket?.destroy();
			} catch {}
		}
		this.clients.clear();

		this.server.closeAllConnections();
		this.server.close();
	}

	// ── Request handler ───────────────────────────────────────────────────────

	/** Returns true if the request carries the correct monitor token (or no token is configured). */
	private tokenOk(req: IncomingMessage): boolean {
		if (!this.monitorToken) return true;
		return req.headers["x-monitor-token"] === this.monitorToken;
	}

	private async handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const rawUrl = req.url ?? "/";
		const url = rawUrl.split("?")[0];
		res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1");
		res.setHeader("Vary", "Origin");

		// All mutating requests require the monitor token when one is configured.
		// GET requests (dashboard UI, SSE stream, file reads) are read-only and exempt.
		if (req.method !== "GET" && !this.tokenOk(req)) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Unauthorized" }));
			return;
		}

		// ── Static files
		if (url === "/" || url === "/index.html") {
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
			});
			res.end(readFileSync(join(this.publicDir, "index.html")));
			return;
		}
		if (url === "/style.css" || url === "/app.js") {
			const ext = url.slice(url.lastIndexOf(".")) as keyof typeof MIME;
			res.writeHead(200, {
				"Content-Type": MIME[ext],
				"Cache-Control": "no-store",
			});
			res.end(readFileSync(join(this.publicDir, url)));
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

		// ── GET /log
		if (url === "/log" && req.method === "GET") {
			const logPath = join(this.workdir, "daemon.log");
			const maxLines = Math.min(
				Number.parseInt(
					new URL(rawUrl, "http://x").searchParams.get("lines") ?? "200",
					10,
				) || 200,
				2000,
			);
			let body = "";
			if (existsSync(logPath)) {
				const content = readFileSync(logPath, "utf8");
				const lines = content.split("\n");
				body = lines.slice(-maxLines).join("\n");
			}
			res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
			res.end(body);
			return;
		}

		// ── GET /agents/:id/mental-map
		const mentalMapMatch = url.match(/^\/agents\/([^/]+)\/mental-map$/);
		if (mentalMapMatch && req.method === "GET") {
			const agentId = decodeURIComponent(mentalMapMatch[1]);
			const doc = await this.db.collection("conversationMessages").findOne(
				{
					agentId,
					missionId: this.missionId,
					mentalMapHtml: { $exists: true },
				},
				{ sort: { turnNumber: -1, seqInTurn: -1 } },
			);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					agentId,
					// biome-ignore lint/suspicious/noExplicitAny: raw MongoDB document
					html: (doc as any)?.mentalMapHtml ?? "",
				}),
			);
			return;
		}

		// ── GET /agents/:id/sessions
		const sessionsMatch = url.match(/^\/agents\/([^/]+)\/sessions$/);
		if (sessionsMatch && req.method === "GET") {
			const agentId = decodeURIComponent(sessionsMatch[1]);

			const llmDocs = await this.db
				.collection("llmCallLog")
				.find({ agentId, missionId: this.missionId })
				.sort({ turnNumber: 1, savedAt: 1 })
				.toArray();

			const byTurn = new Map<number, typeof llmDocs>();
			for (const d of llmDocs) {
				// biome-ignore lint/suspicious/noExplicitAny: raw MongoDB document
				const t = (d as any).turnNumber ?? 0;
				if (!byTurn.has(t)) byTurn.set(t, []);
				byTurn.get(t)?.push(d);
			}

			const toolCounts = await this.db
				.collection("conversationMessages")
				.aggregate([
					{
						$match: {
							agentId,
							missionId: this.missionId,
							"message.role": "toolResult",
							parentToolUseId: { $exists: false },
						},
					},
					{ $group: { _id: "$turnNumber", count: { $sum: 1 } } },
				])
				.toArray();
			const toolCountMap = new Map(
				// biome-ignore lint/suspicious/noExplicitAny: raw MongoDB aggregate result
				toolCounts.map((t: any) => [t._id, t.count]),
			);

			const sessions = Array.from(byTurn.entries()).map(([turn, docs]) => {
				// biome-ignore lint/suspicious/noExplicitAny: raw MongoDB documents
				const isReflection = (docs[0] as any)?.isReflection ?? false;
				// biome-ignore lint/suspicious/noExplicitAny: raw MongoDB documents
				const startTime = (docs[0] as any)?.savedAt;
				// biome-ignore lint/suspicious/noExplicitAny: raw MongoDB documents
				const endTime = (docs[docs.length - 1] as any)?.savedAt;
				const durationMs =
					startTime && endTime
						? new Date(endTime).getTime() - new Date(startTime).getTime()
						: 0;
				const totals = docs.reduce(
					// biome-ignore lint/suspicious/noExplicitAny: raw MongoDB documents
					(acc: any, d: any) => ({
						inputTokens: acc.inputTokens + (d.usage?.inputTokens ?? 0),
						outputTokens: acc.outputTokens + (d.usage?.outputTokens ?? 0),
						cacheReadTokens:
							acc.cacheReadTokens + (d.usage?.cacheReadTokens ?? 0),
						costUsd: acc.costUsd + (d.usage?.cost?.total ?? 0),
					}),
					{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
				);
				return {
					turnNumber: turn,
					isReflection,
					startTime,
					endTime,
					durationMs,
					llmCalls: docs.length,
					toolCalls: toolCountMap.get(turn) ?? 0,
					...totals,
				};
			});

			sessions.sort((a, b) => a.turnNumber - b.turnNumber);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(sessions));
			return;
		}

		// ── GET /agents/:id/sessions/:turn
		const sessionDetailMatch = url.match(
			/^\/agents\/([^/]+)\/sessions\/(\d+)$/,
		);
		if (sessionDetailMatch && req.method === "GET") {
			const agentId = decodeURIComponent(sessionDetailMatch[1]);
			const turnNumber = parseInt(sessionDetailMatch[2], 10);

			const msgs = await this.db
				.collection("conversationMessages")
				.find({ agentId, missionId: this.missionId, turnNumber })
				.sort({ seqInTurn: 1 })
				.toArray();

			const llmCalls = await this.db
				.collection("llmCallLog")
				.find({ agentId, missionId: this.missionId, turnNumber })
				.sort({ savedAt: 1 })
				.toArray();

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ turnNumber, messages: msgs, llmCalls }));
			return;
		}

		// ── GET /agents/:id/usage
		const usageMatch = url.match(/^\/agents\/([^/]+)\/usage$/);
		if (usageMatch && req.method === "GET") {
			const agentId = decodeURIComponent(usageMatch[1]);
			const docs = await this.db
				.collection("llmCallLog")
				.find({ missionId: this.missionId, agentId })
				.sort({ turnNumber: 1, savedAt: 1 })
				.toArray();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify(
					docs.map((d) => ({
						turnNumber: d.turnNumber ?? 0,
						isReflection: d.isReflection ?? false,
						savedAt: d.savedAt,
						usage: d.usage ?? null,
					})),
				),
			);
			return;
		}

		// ── GET /schedule
		if (url === "/schedule" && req.method === "GET") {
			const docs = await this.db
				.collection("scheduled_messages")
				.find({ missionId: this.missionId, deliveredAt: { $exists: false } })
				.sort({ scheduledFor: 1 })
				.limit(50)
				.toArray();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify(
					docs.map((d) => ({
						id: String(d._id),
						to: d.to ?? [],
						subject: d.subject ?? "",
						cronExpression: d.cronExpression ?? null,
						scheduledFor: d.scheduledFor ?? null,
					})),
				),
			);
			return;
		}

		// ── DELETE /schedule/:id
		const scheduleDeleteMatch = url.match(/^\/schedule\/([^/]+)$/);
		if (scheduleDeleteMatch && req.method === "DELETE") {
			if (!this.cancelSchedule) {
				res.writeHead(501, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "cancelSchedule not configured" }));
				return;
			}
			try {
				await this.cancelSchedule(scheduleDeleteMatch[1]);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (e) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: (e as Error).message }));
			}
			return;
		}

		// ── GET /files/shared
		if (url === "/files/shared" && req.method === "GET") {
			const userPath =
				new URL(rawUrl, "http://x").searchParams.get("path") ?? "";
			this.serveFilePath(this.sharedDir, userPath, res);
			return;
		}

		// ── GET /files/workdir/:agentId
		const workdirFileMatch = url.match(/^\/files\/workdir\/([^/]+)$/);
		if (workdirFileMatch && req.method === "GET") {
			const agentId = decodeURIComponent(workdirFileMatch[1]);
			const root = this.agentWorkdirs.get(agentId);
			if (!root) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Agent workdir not found" }));
				return;
			}
			const userPath =
				new URL(rawUrl, "http://x").searchParams.get("path") ?? "";
			this.serveFilePath(root, userPath, res);
			return;
		}

		// ── POST /files/shared/write  (copilot: write a file to sharedDir)
		if (url === "/files/shared/write" && req.method === "POST") {
			const body = await readBody(req);
			this.writeFilePath(this.sharedDir, body, res);
			return;
		}

		// ── POST /files/workdir/:agentId/write  (copilot: write a file to agent workdir)
		const workdirWriteMatch = url.match(/^\/files\/workdir\/([^/]+)\/write$/);
		if (workdirWriteMatch && req.method === "POST") {
			const agentId = decodeURIComponent(workdirWriteMatch[1]);
			const root = this.agentWorkdirs.get(agentId);
			if (!root) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Agent workdir not found" }));
				return;
			}
			const body = await readBody(req);
			this.writeFilePath(root, body, res);
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
						error:
							"to (non-empty string[]), subject (string), and message (string) are required",
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

		// ── POST /extend-budget
		if (url === "/extend-budget" && req.method === "POST") {
			const body = await readBody(req);
			let addUsd = 5;
			try {
				const parsed = JSON.parse(body) as Record<string, unknown>;
				if (typeof parsed.addUsd === "number" && parsed.addUsd > 0) {
					addUsd = parsed.addUsd;
				}
			} catch {
				// Malformed JSON — use default $5
			}
			const previousCap = this.currentCapUsd ?? 0;
			this.currentCapUsd = previousCap + addUsd;
			this.budgetPaused = false;
			console.log(
				`[monitor] Budget extended by $${addUsd.toFixed(2)} — new cap: $${this.currentCapUsd.toFixed(2)}`,
			);
			this.onBudgetExtended?.(this.currentCapUsd);
			if (this.budgetResolve) {
				this.budgetResolve();
				this.budgetResolve = null;
			}
			this.push("cost-resumed", {
				addUsd,
				newCapUsd: this.currentCapUsd,
				budgetPaused: false,
			});
			this.push("status", this.statusPayload());
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, newCapUsd: this.currentCapUsd }));
			return;
		}

		// ── POST /set-budget — set an absolute spending cap (cf. /extend-budget which adds)
		if (url === "/set-budget" && req.method === "POST") {
			const body = await readBody(req);
			let capUsd: number | null = null;
			try {
				const parsed = JSON.parse(body) as Record<string, unknown>;
				if (typeof parsed.capUsd === "number" && parsed.capUsd > 0) {
					capUsd = parsed.capUsd;
				}
			} catch {
				// fall through to validation error below
			}
			if (capUsd === null) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: "capUsd must be > 0" }));
				return;
			}
			this.currentCapUsd = capUsd;
			this.onBudgetExtended?.(capUsd);
			// Lift the pause if the new cap is above what has been spent.
			if (this.budgetPaused && capUsd > this.accumulator.totalCostUsd()) {
				this.budgetPaused = false;
				if (this.budgetResolve) {
					this.budgetResolve();
					this.budgetResolve = null;
				}
				this.push("cost-resumed", { newCapUsd: capUsd, budgetPaused: false });
			}
			console.log(`[monitor] Budget cap set to $${capUsd.toFixed(2)}`);
			this.push("status", this.statusPayload());
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, newCapUsd: capUsd }));
			return;
		}

		// ── POST /pause-agent — halt one agent at the next dispatch boundary
		if (url === "/pause-agent" && req.method === "POST") {
			const agentId = await this.readAgentId(req, res);
			if (agentId === null) return;
			this.pausedAgents.add(agentId);
			console.log(`[monitor] Agent "${agentId}" paused`);
			this.push("agent-paused", { agentId });
			this.push("status", this.statusPayload());
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, paused: [...this.pausedAgents] }));
			return;
		}

		// ── POST /resume-agent — lift a per-agent pause
		if (url === "/resume-agent" && req.method === "POST") {
			const agentId = await this.readAgentId(req, res);
			if (agentId === null) return;
			this.pausedAgents.delete(agentId);
			console.log(`[monitor] Agent "${agentId}" resumed`);
			this.push("agent-resumed", { agentId });
			this.push("status", this.statusPayload());
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, paused: [...this.pausedAgents] }));
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

	// ── File browser ──────────────────────────────────────────────────────────

	private serveFilePath(
		root: string,
		userPath: string,
		res: ServerResponse,
	): void {
		const abs = resolve(root, userPath);
		if (!abs.startsWith(root)) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Path outside root" }));
			return;
		}
		if (!existsSync(abs)) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Not found" }));
			return;
		}
		const stat = statSync(abs);
		res.writeHead(200, { "Content-Type": "application/json" });
		if (stat.isDirectory()) {
			let entries: string[];
			try {
				entries = readdirSync(abs);
			} catch {
				entries = [];
			}
			const listed = entries.map((name) => {
				try {
					const s = statSync(join(abs, name));
					return {
						name,
						type: s.isDirectory() ? "dir" : "file",
						size: s.isDirectory() ? undefined : s.size,
						modified: s.mtime.toISOString(),
					};
				} catch {
					return { name, type: "file" as const };
				}
			});
			listed.sort((a, b) => {
				if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
			res.end(JSON.stringify({ type: "dir", path: userPath, entries: listed }));
			return;
		}
		// File
		const ext = extname(abs).toLowerCase();
		const imageMime = IMAGE_MIME[ext];
		if (imageMime) {
			const content = readFileSync(abs).toString("base64");
			res.end(
				JSON.stringify({
					type: "file",
					name: basename(abs),
					encoding: "base64",
					mimeType: imageMime,
					content,
				}),
			);
			return;
		}
		if (TEXT_EXTENSIONS.has(ext) || ext === "") {
			const MAX_BYTES = 200 * 1024;
			const raw = readFileSync(abs);
			const content = raw.slice(0, MAX_BYTES).toString("utf8");
			res.end(
				JSON.stringify({
					type: "file",
					name: basename(abs),
					encoding: "text",
					mimeType: "text/plain",
					content,
					truncated: raw.length > MAX_BYTES,
				}),
			);
			return;
		}
		res.end(
			JSON.stringify({ type: "file", name: basename(abs), encoding: "binary" }),
		);
	}

	private writeFilePath(
		root: string,
		rawBody: string,
		res: ServerResponse,
	): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawBody);
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Invalid JSON" }));
			return;
		}
		const { path: userPath, content } = parsed as Record<string, unknown>;
		if (typeof userPath !== "string" || typeof content !== "string") {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: "path (string) and content (string) are required",
				}),
			);
			return;
		}
		const abs = resolve(root, userPath);
		if (!abs.startsWith(root)) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Path outside root" }));
			return;
		}
		try {
			mkdirSync(resolve(abs, ".."), { recursive: true });
			writeFileSync(abs, content, "utf-8");
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		} catch (e) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: (e as Error).message }));
		}
	}

	// ── Change stream watchers ────────────────────────────────────────────────

	/**
	 * Parse and validate an `agentId` from a POST body for the pause/resume
	 * endpoints. Writes a 400 response and returns null when the body is malformed
	 * or names an agent not in this mission's team — so a stray id can never
	 * silently create a phantom pause entry.
	 */
	private async readAgentId(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<string | null> {
		const body = await readBody(req);
		let agentId: string | null = null;
		try {
			const parsed = JSON.parse(body) as Record<string, unknown>;
			if (typeof parsed.agentId === "string" && parsed.agentId.trim()) {
				agentId = parsed.agentId.trim();
			}
		} catch {
			// fall through to 400 below
		}
		if (agentId === null) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: "agentId required" }));
			return null;
		}
		if (!this.agents.some((a) => a.id === agentId)) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({ ok: false, error: `unknown agent "${agentId}"` }),
			);
			return null;
		}
		return agentId;
	}

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
					this.server.once("close", () => {
						stream.close().catch(() => {});
						resolve();
					});
				});
				return;
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
						const doc = change.fullDocument as {
							agentId: string;
						} & Record<string, unknown>;
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
			running: [...this.runningAgents],
			pausedAgents: [...this.pausedAgents],
			missionTotalUsd: this.accumulator.totalCostUsd(),
			maxCostUsd: this.currentCapUsd,
			budgetPaused: this.budgetPaused,
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
