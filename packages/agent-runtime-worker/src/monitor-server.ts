import { execFile } from "node:child_process";
import {
	createReadStream,
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
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Model } from "@mariozechner/pi-ai";
import JSZip from "jszip";
import type { Db } from "mongodb";
import type { StatsCollector } from "./agent-stats.js";
import {
	createDescribeImage,
	createOcrPage,
	createPageVisualDescribe,
	processBuffer,
} from "./document-processor.js";
import { missionLifetimeCostUsd } from "./limits.js";
import { MAILBOX_MAX_BODY_BYTES, type MailboxRepository } from "./mailbox.js";
import type { MissionConfigRepository } from "./mission-config.js";
import { createAgentSessionsRoutes } from "./monitor-routes/agent-sessions.js";
import { createBudgetRoutes } from "./monitor-routes/budget.js";
import { createDashboardShellRoutes } from "./monitor-routes/dashboard-shell.js";
import { createFileBrowsingRoutes } from "./monitor-routes/file-browsing.js";
import { createFileEditRoutes } from "./monitor-routes/file-edit.js";
import { createLifecycleRoutes } from "./monitor-routes/lifecycle.js";
import { createLogRoutes } from "./monitor-routes/log.js";
import { createMailboxRoutes } from "./monitor-routes/mailbox.js";
import { createPauseResumeRoutes } from "./monitor-routes/pause-resume.js";
import { createRunControlRoutes } from "./monitor-routes/run-control.js";
import { createScheduleRoutes } from "./monitor-routes/schedule.js";
import { createStaticAssetsRoutes } from "./monitor-routes/static-assets.js";
import { createTraceRoutes } from "./monitor-routes/trace.js";
import type { RouteEntry } from "./monitor-routes/types.js";
import { createUploadDownloadRoutes } from "./monitor-routes/upload-download.js";
import type { UsageAccumulator } from "./usage.js";
import { WorkspaceGit } from "./workspace-git.js";

/** Body cap for file uploads (base64-encoded). ~22 MB raw file. */
export const UPLOAD_MAX_BODY_BYTES = 30 * 1024 * 1024;

/**
 * Cap for a text file's preview content and — since a truncated file must
 * never be editable, editing would silently discard the un-fetched remainder
 * on save — the same figure gates whether the cockpit's Edit button appears.
 */
export const TEXT_FILE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Cap for the raw POST body of a file-edit request — must exceed
 * TEXT_FILE_MAX_BYTES with margin for the JSON envelope (the `path` field)
 * and string-escaping overhead, or a legitimate near-the-limit edit would be
 * rejected by readBody() before handleFileEdit's own content-length check
 * ever runs. readBody()'s default (MAILBOX_MAX_BODY_BYTES, sized for mailbox
 * messages) is far too small for this route.
 */
export const FILE_EDIT_MAX_BODY_BYTES = TEXT_FILE_MAX_BYTES * 2;

// Default public/ dir: next to the compiled JS (dist/public/).
// Tests running from src/ via Vitest pass an explicit publicDir to the constructor.
const DEFAULT_PUBLIC_DIR = join(
	fileURLToPath(new URL(".", import.meta.url)),
	"public",
);

export const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css",
	".js": "application/javascript",
};

export const TEXT_EXTENSIONS = new Set([
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

const pexec = promisify(execFile);

export const IMAGE_MIME: Record<string, string> = {
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
	| "agent-resumed"
	| "kpi-recorded";

export interface AgentInfo {
	id: string;
	name: string;
	role: string;
}

/** One entry of a file's git provenance — see `resolveFileHistory`. */
export interface FileHistoryEntry {
	commit: string;
	timestamp: string;
	agentId: string | null;
	turnNumber: number | null;
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
 *   GET    /files/history?path=           git provenance for a sharedDir file (agent/turn per commit)
 *   GET    /files/workdir/:id?path=       browse / read agent workdir
 *   GET    /mission-stats                 Trace: lifetime cost/calls/turns per agent (missionStats)
 *   GET    /cost-series                   Trace: per-agent per-turn stats, for the cost-over-time chart
 *                                          and its turn/file/anomaly markers (agentTurnStats)
 *   GET    /interactions                  Trace: message counts between agent pairs (mailbox)
 *   GET    /message-events                Trace: per-message timestamps, for the message/wakeup markers
 *   POST   /files/shared/write            write a file to sharedDir (copilot)
 *   POST   /files/workdir/:id/write       write a file to agent workdir (copilot)
 *   DELETE /schedule/:id                  cancel a scheduled message
 *   POST   /send-message                  inject a mailbox message
 *   POST   /step                          advance one step
 *   POST   /toggle-step                   enable / disable step mode
 *   POST   /extend-budget                 add USD to spending cap
 *   POST   /upload                        process an operator file → artifact + mailbox
 *   GET    /download?path=[&format=zip]   stream a file, or a folder subtree as a zip
 *   POST   /start                         unblock waitForStart
 *   POST   /stop                          graceful daemon shutdown
 */
/**
 * SSE heartbeat interval. The control-plane→execution-plane WireGuard path has
 * a documented >60s idle-connection cutoff (operational-resilience.md Layer 1)
 * that drops the TCP connection silently — no FIN/RST reaches the browser, so
 * EventSource's native reconnect (which only fires on a detected close) never
 * triggers. A periodic named `ping` event keeps the connection active through
 * that hop — sent as a real event (not a `:`-prefixed comment) so the
 * client's own watchdog (cockpit App.tsx's useMissionStatus) can observe it
 * and distinguish "idle but alive" from "silently dead".
 */
const SSE_HEARTBEAT_MS = 20_000;

export class MonitorServer {
	private readonly clients = new Set<ServerResponse>();
	private readonly server;
	/**
	 * Route table (Sprint 28c, issue #32) — grows one cluster at a time as
	 * `handleRequest`'s legacy if/else chain is migrated. Checked before the
	 * legacy chain; the two never overlap since a route is only ever migrated
	 * once (see handleRequest's dispatch loop).
	 */
	private readonly routes: RouteEntry[];
	private readonly workspaceGit: WorkspaceGit;
	private heartbeatTimer: NodeJS.Timeout | null = null;

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

	/**
	 * Vision model for the upload pipeline's image captioning. Set by the daemon
	 * after construction. When absent, uploaded-document images are not
	 * auto-described — they fall back to InspectImage pointers.
	 */
	visionModel?: Model<string>;

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
		private readonly statsCollector: StatsCollector,
		private readonly missionConfig: MissionConfigRepository,
		private readonly mailboxRepo: MailboxRepository,
		private readonly agents: AgentInfo[],
		private readonly onStop: () => void,
		private readonly startedAt = new Date(),
		private readonly workdir: string = process.cwd(),
		private readonly sharedDir: string = process.cwd(),
		private readonly cancelSchedule?: (id: string) => Promise<void>,
		private readonly publicDir: string = DEFAULT_PUBLIC_DIR,
		/**
		 * Git-commit-on-sleep checkpointer, shared with the orchestrator so an
		 * operator's file edit (POST /files/shared/edit) commits through the same
		 * serialized queue as agent turn-end commits, never racing it. Falls back
		 * to a private instance when absent (tests that construct MonitorServer
		 * standalone, with no orchestrator running alongside it).
		 */
		workspaceGit?: WorkspaceGit,
	) {
		this.workspaceGit = workspaceGit ?? new WorkspaceGit(this.sharedDir);
		this.routes = [
			...createDashboardShellRoutes({
				statusPayload: () => this.statusPayload(),
				clients: this.clients,
				agents: this.agents,
			}),
			...createStaticAssetsRoutes({ publicDir: this.publicDir }),
			...createMailboxRoutes({
				db: this.db,
				missionId: this.missionId,
				mailboxRepo: this.mailboxRepo,
			}),
			...createLogRoutes({ workdir: this.workdir }),
			...createFileBrowsingRoutes({
				sharedDir: this.sharedDir,
				getAgentWorkdirs: () => this.agentWorkdirs,
				serveFilePath: (root, userPath, res) =>
					this.serveFilePath(root, userPath, res),
				serveFileHistory: (userPath, res) =>
					this.serveFileHistory(userPath, res),
				writeFilePath: (root, rawBody, res) =>
					this.writeFilePath(root, rawBody, res),
			}),
			...createFileEditRoutes({
				handleFileEdit: (req, res) => this.handleFileEdit(req, res),
			}),
			...createAgentSessionsRoutes({
				db: this.db,
				missionId: this.missionId,
			}),
			...createScheduleRoutes({
				db: this.db,
				missionId: this.missionId,
				cancelSchedule: this.cancelSchedule,
			}),
			...createTraceRoutes({
				db: this.db,
				missionId: this.missionId,
			}),
			...createRunControlRoutes({
				getStepResolve: () => this.stepResolve,
				setStepResolve: (fn) => {
					this.stepResolve = fn;
				},
				getStepEnabled: () => this.stepEnabled,
				setStepEnabled: (enabled) => {
					this.stepEnabled = enabled;
				},
				getStarted: () => this.started,
				setStarted: (started) => {
					this.started = started;
				},
				getStartResolve: () => this.startResolve,
				setStartResolve: (fn) => {
					this.startResolve = fn;
				},
				push: (type, payload) => this.push(type, payload),
			}),
			...createPauseResumeRoutes({
				pausedAgents: this.pausedAgents,
				push: (type, payload) => this.push(type, payload),
				statusPayload: () => this.statusPayload(),
				readAgentId: (req, res) => this.readAgentId(req, res),
			}),
			...createBudgetRoutes({
				missionId: this.missionId,
				missionConfig: this.missionConfig,
				statsCollector: this.statsCollector,
				getBudgetPaused: () => this.budgetPaused,
				setBudgetPaused: (paused) => {
					this.budgetPaused = paused;
				},
				getBudgetResolve: () => this.budgetResolve,
				setBudgetResolve: (fn) => {
					this.budgetResolve = fn;
				},
				push: (type, payload) => this.push(type, payload),
				statusPayload: () => this.statusPayload(),
			}),
			...createLifecycleRoutes({
				push: (type, payload) => this.push(type, payload),
				onStop: () => this.onStop(),
			}),
			...createUploadDownloadRoutes({
				handleUpload: (req, res) => this.handleUpload(req, res),
				handleDownload: (rawUrl, res) => this.handleDownload(rawUrl, res),
			}),
		];
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
	async notifyCostPause(spentUsd: number, capUsd: number): Promise<void> {
		this.budgetPaused = true;
		console.warn(
			`[monitor] Budget cap $${capUsd.toFixed(2)} reached ($${spentUsd.toFixed(4)} spent) — pausing`,
		);
		this.push("cost-pause", { spentUsd, capUsd, budgetPaused: true });
		this.push("status", await this.statusPayload());
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

		this.heartbeatTimer = setInterval(() => {
			for (const client of this.clients) {
				try {
					client.write("event: ping\ndata: {}\n\n");
				} catch {
					this.clients.delete(client);
				}
			}
		}, SSE_HEARTBEAT_MS);
	}

	stop(): void {
		// Resolve all blocked waitFor* promises so the orchestration loop can
		// reach its finally block before the process exits.
		this.startResolve?.();
		this.budgetResolve?.();
		this.stepResolve?.();

		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

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

		// Route table (Sprint 28c, issue #32).
		for (const route of this.routes) {
			if (route.method !== req.method) continue;
			const ctx = { req, res, rawUrl, url };
			if (typeof route.path === "string" || Array.isArray(route.path)) {
				const paths = Array.isArray(route.path) ? route.path : [route.path];
				if (!paths.includes(url)) continue;
				await route.handler(ctx);
				return;
			}
			const m = url.match(route.path);
			if (m) {
				await route.handler(ctx, ...m.slice(1).map(decodeURIComponent));
				return;
			}
		}

		res.writeHead(404).end();
	}

	/**
	 * Process an operator upload: save the pristine file under uploads/<date>/,
	 * run the shared document processor into artifacts/ ONCE, and post a single
	 * mailbox message to all recipients pointing at the processed content.md.
	 */
	private async handleUpload(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		let raw: string;
		try {
			raw = await readBody(req, UPLOAD_MAX_BODY_BYTES);
		} catch (e) {
			res.writeHead(413, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: (e as Error).message }));
			return;
		}
		let p: Record<string, unknown>;
		try {
			p = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Invalid JSON" }));
			return;
		}
		const filename = typeof p.filename === "string" ? p.filename : "";
		// One or more recipients: `agentIds` (string[]) preferred; `agentId`
		// (string) accepted for back-compat. The file is processed once and a
		// single mailbox message goes to all recipients (no duplicate work).
		const agentIds = Array.isArray(p.agentIds)
			? p.agentIds.filter((a): a is string => typeof a === "string")
			: typeof p.agentId === "string"
				? [p.agentId]
				: [];
		const contentBase64 =
			typeof p.contentBase64 === "string" ? p.contentBase64 : "";
		const mimeType = typeof p.mimeType === "string" ? p.mimeType : undefined;
		const subject = typeof p.subject === "string" ? p.subject : "";
		const message = typeof p.body === "string" ? p.body : "";
		if (!filename || !contentBase64) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({ error: "filename and contentBase64 are required" }),
			);
			return;
		}
		const unknown = agentIds.filter(
			(id) => !this.agents.some((a) => a.id === id),
		);
		if (agentIds.length === 0 || unknown.length > 0) {
			res.writeHead(agentIds.length === 0 ? 400 : 404, {
				"Content-Type": "application/json",
			});
			res.end(
				JSON.stringify({
					error:
						agentIds.length === 0
							? "at least one recipient (agentIds) is required"
							: `unknown agent(s): ${unknown.join(", ")}`,
				}),
			);
			return;
		}

		const bytes = Buffer.from(contentBase64, "base64");

		// Save the pristine original under uploads/<date>/ for provenance.
		const safeName = basename(filename);
		const dateDir = new Date().toISOString().slice(0, 10);
		const uploadDir = join(this.sharedDir, "uploads", dateDir);
		try {
			mkdirSync(uploadDir, { recursive: true });
			writeFileSync(join(uploadDir, safeName), bytes);
		} catch (e) {
			console.error(`[monitor] upload save failed: ${(e as Error).message}`);
		}

		try {
			const describeImage = this.visionModel
				? createDescribeImage(this.visionModel)
				: undefined;
			// A PDF page's "Page visual" note gets a description-only prompt, not
			// describeImage's — that page's real text is already captured by mupdf,
			// so asking for a transcription too just duplicates it (found live).
			const describePageVisual = this.visionModel
				? createPageVisualDescribe(this.visionModel)
				: undefined;
			// Issue #50: scanned PDFs (no embedded text layer) reuse the same
			// vision model, prompted for verbatim transcription instead of a caption.
			const ocrPage = this.visionModel
				? createOcrPage(this.visionModel)
				: undefined;
			const result = await processBuffer(bytes, {
				filename: safeName,
				mimeType,
				artifactsDir: this.sharedDir,
				describeImage,
				describePageVisual,
				ocrPage,
			});

			// Issue #51: artifacts live under sharedDir, but the agent's Bash tool
			// runs with cwd set to its own workdir — a bare "artifacts/..." path
			// silently resolves nowhere. $SHARED_DIR is already injected into every
			// Bash subprocess (tools.ts), so the shell resolves it there. But
			// mission-copilot has no Bash-only recipients guarantee: it reads
			// artifacts via the `ReadSharedFile` tool, a direct (non-shell) tool
			// call whose `path` argument is never shell-expanded — pasting the
			// `$SHARED_DIR`-prefixed hint into it resolves to a literal, nonexistent
			// "$SHARED_DIR" subdirectory (found live). Give the sharedDir-relative
			// path as the primary reference (correct for ReadSharedFile) and the
			// Bash form as an explicit second option, so neither tool is misled.
			const relPath = `artifacts/${result.artifactId}/content.md`;
			const body = [
				message.trim(),
				"",
				`📎 Uploaded file: ${safeName}`,
				`Processed → \`${relPath}\` (path relative to the shared dir; ${result.summary}, ${result.processingStatus}).`,
				`Bash: \`cat $SHARED_DIR/${relPath}\`  ·  ReadSharedFile tool: path = \`${relPath}\``,
			]
				.join("\n")
				.trim();
			await this.mailboxRepo.post({
				missionId: this.missionId,
				from: "user",
				to: agentIds,
				subject: subject || `Uploaded: ${safeName}`,
				body,
			});

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					ok: true,
					artifactId: result.artifactId,
					format: result.format,
					processingStatus: result.processingStatus,
				}),
			);
		} catch (e) {
			console.error(
				`[monitor] upload processing failed: ${(e as Error).message}`,
			);
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: (e as Error).message }));
		}
	}

	/** Stream a file (attachment) or a folder subtree as a zip from sharedDir. */
	private handleDownload(rawUrl: string, res: ServerResponse): void {
		const params = new URL(rawUrl, "http://x").searchParams;
		const userPath = params.get("path") ?? "";
		const asZip = params.get("format") === "zip";
		// Sprint 27: lets a chat/mailbox message embed an inline <img src=...>
		// pointing straight at this route (renderMarkdown's image support) —
		// the default (no `inline`) keeps forcing a download, unchanged for the
		// Files panel's own "Download" button and every other existing caller.
		const inline = params.get("inline") === "1";

		const abs = resolve(this.sharedDir, userPath);
		if (abs !== this.sharedDir && !abs.startsWith(`${this.sharedDir}/`)) {
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
		if (stat.isDirectory() || asZip) {
			const zip = new JSZip();
			addToZip(zip, abs, abs);
			zip
				.generateAsync({ type: "nodebuffer" })
				.then((buf) => {
					res.writeHead(200, {
						"Content-Type": "application/zip",
						"Content-Disposition": `attachment; filename="${basename(abs) || "download"}.zip"`,
					});
					res.end(buf);
				})
				.catch((e: Error) => {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: e.message }));
				});
			return;
		}

		const imageMime = inline
			? IMAGE_MIME[extname(abs).toLowerCase()]
			: undefined;
		if (imageMime) {
			// No Content-Disposition — this must render in an <img> tag, not
			// prompt a save dialog.
			res.writeHead(200, { "Content-Type": imageMime });
			createReadStream(abs).pipe(res);
			return;
		}

		res.writeHead(200, {
			"Content-Type": "application/octet-stream",
			"Content-Disposition": `attachment; filename="${basename(abs)}"`,
		});
		createReadStream(abs).pipe(res);
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
			const raw = readFileSync(abs);
			const content = raw.slice(0, TEXT_FILE_MAX_BYTES).toString("utf8");
			res.end(
				JSON.stringify({
					type: "file",
					name: basename(abs),
					encoding: "text",
					mimeType: "text/plain",
					content,
					truncated: raw.length > TEXT_FILE_MAX_BYTES,
				}),
			);
			return;
		}
		res.end(
			JSON.stringify({ type: "file", name: basename(abs), encoding: "binary" }),
		);
	}

	/**
	 * Provenance for a file: its git history (via `git log --follow`), each
	 * commit joined against `agentTurnStats.gitCommit` to name the agent/turn
	 * that produced it (git-commit-on-sleep, Sprint 25). Commits with no match
	 * (e.g. template provisioning, or a future operator edit) are still
	 * returned with agentId/turnNumber null — the file viewer degrades to
	 * showing just the commit rather than hiding history.
	 */
	private async serveFileHistory(
		userPath: string,
		res: ServerResponse,
	): Promise<void> {
		const history = await this.resolveFileHistory(userPath);
		if (history === null) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Path outside root" }));
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(history));
	}

	/**
	 * Git provenance for a sharedDir file: commit history joined against
	 * `agentTurnStats.gitCommit` to name the agent/turn that produced each
	 * commit. Most-recent commit first. Returns `null` on a path-traversal
	 * attempt; `[]` when the file has no history (never committed, or git
	 * unavailable — a normal, renderable state, not an error). Shared by the
	 * `GET /files/history` route and the file-edit route's notify-last-agent
	 * lookup — both need "who touched this file most recently."
	 */
	private async resolveFileHistory(
		userPath: string,
	): Promise<FileHistoryEntry[] | null> {
		const abs = resolve(this.sharedDir, userPath);
		if (abs !== this.sharedDir && !abs.startsWith(`${this.sharedDir}/`)) {
			return null;
		}
		const relPath = relative(this.sharedDir, abs);

		let commits: { commit: string; timestamp: string }[] = [];
		try {
			const { stdout } = await pexec("git", [
				"-C",
				this.sharedDir,
				"log",
				"--follow",
				"--format=%H|%cI",
				"-n",
				"20",
				"--",
				relPath,
			]);
			commits = stdout
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
				.map((l) => {
					const [commit, timestamp] = l.split("|");
					return { commit, timestamp };
				});
		} catch (e) {
			// Not a git repo, file never committed, or git unavailable — no
			// history is a normal, renderable state, not an error.
			console.warn(
				`[monitor] git history lookup failed for ${relPath}: ${(e as Error).message}`,
			);
		}

		if (commits.length === 0) return [];

		const turns = await this.db
			.collection("agentTurnStats")
			.find(
				{
					missionId: this.missionId,
					gitCommit: { $in: commits.map((c) => c.commit) },
				},
				{ projection: { agentId: 1, turnNumber: 1, gitCommit: 1, _id: 0 } },
			)
			.toArray();
		const turnByCommit = new Map(
			turns.map((t) => [
				t.gitCommit as string,
				{ agentId: t.agentId as string, turnNumber: t.turnNumber as number },
			]),
		);

		return commits.map((c) => ({
			commit: c.commit,
			timestamp: c.timestamp,
			agentId: turnByCommit.get(c.commit)?.agentId ?? null,
			turnNumber: turnByCommit.get(c.commit)?.turnNumber ?? null,
		}));
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

	/**
	 * POST /files/shared/edit — operator edits an existing text file from the
	 * cockpit. Deliberately separate from `writeFilePath`/`/files/shared/write`
	 * above: that route is used by the copilot mid-turn, whose own turn-end
	 * commit already sweeps up whatever it wrote there. An operator edit has
	 * no turn — nothing would ever commit or notify it unless this route does
	 * so itself.
	 *
	 * Validates the extension against the same `TEXT_EXTENSIONS` allowlist the
	 * read side uses — the cockpit UI only offers Edit for that bucket, but
	 * the server must not trust a client to enforce that alone (a buggy or
	 * malicious caller could otherwise overwrite a binary file with arbitrary
	 * text through this route). Commits immediately through the shared
	 * `WorkspaceGit` queue (so it can never race an agent's turn-end commit),
	 * then notifies whichever agent's turn most recently touched this file,
	 * if any — skipped, not guessed, when history has no resolved agent.
	 */
	private async handleFileEdit(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		let rawBody: string;
		try {
			rawBody = await readBody(req, FILE_EDIT_MAX_BODY_BYTES);
		} catch {
			// readBody destroys the socket on overflow — res is no longer usable
			// for this connection. Nothing to write; the client sees a reset.
			return;
		}
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

		const abs = resolve(this.sharedDir, userPath);
		if (abs !== this.sharedDir && !abs.startsWith(`${this.sharedDir}/`)) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Path outside root" }));
			return;
		}

		const ext = extname(abs).toLowerCase();
		if (!TEXT_EXTENSIONS.has(ext) && ext !== "") {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: `"${ext}" files are not editable from the cockpit — only text-type files can be`,
				}),
			);
			return;
		}

		if (Buffer.byteLength(content, "utf8") > TEXT_FILE_MAX_BYTES) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: `Content exceeds the ${TEXT_FILE_MAX_BYTES / (1024 * 1024)} MB edit limit`,
				}),
			);
			return;
		}

		const relPath = relative(this.sharedDir, abs);

		// Who to notify — resolved BEFORE the write, so it reflects who touched
		// the file prior to this edit, not this edit's own (not-yet-created) commit.
		const history = await this.resolveFileHistory(userPath);
		const lastAgentId = history?.[0]?.agentId ?? null;

		try {
			mkdirSync(resolve(abs, ".."), { recursive: true });
			writeFileSync(abs, content, "utf-8");
		} catch (e) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: (e as Error).message }));
			return;
		}

		const commitResult = await this.workspaceGit.commit(
			`operator edit: ${relPath}`,
		);

		if (lastAgentId) {
			try {
				await this.mailboxRepo.post({
					missionId: this.missionId,
					from: "user",
					to: [lastAgentId],
					subject: `File edited: ${relPath}`,
					body: `The operator edited \`${relPath}\`, which you last touched. Read it again before assuming your previous version is still current.`,
				});
			} catch (e) {
				// Notification failing must not fail the save — the edit is
				// already committed at this point.
				console.error("[monitor] file-edit notification failed", {
					missionId: this.missionId,
					path: relPath,
					agentId: lastAgentId,
					error: (e as Error).message,
				});
			}
		}

		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, commit: commitResult?.commit ?? null }));
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
						this.statusPayload()
							.then((payload) => this.push("status", payload))
							.catch((e) =>
								console.error(
									`[monitor] statusPayload failed after mailbox insert: ${(e as Error).message}`,
								),
							);
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

	/**
	 * Reads mission cost fresh from `missionStats` and the spend cap fresh from
	 * the mission's persisted `teamConfigYaml` on every call — never cached —
	 * so this payload can never show a stale total or a stale cap after a
	 * daemon restart, and reflects a cap change made by any writer (cockpit,
	 * mission copilot) immediately (see agent-stats.ts header + ADR-0018 for
	 * the rationale). Token/call-count fields (input/output/cacheRead/llmCalls)
	 * are session-only telemetry from `UsageAccumulator` and stay sourced from
	 * it; they're informational, not checked against any limit.
	 */
	private async statusPayload() {
		const uptimeSec = Math.floor(
			(Date.now() - this.startedAt.getTime()) / 1000,
		);
		const [snapshot, liveConfig] = await Promise.all([
			this.statsCollector.readMissionSnapshot(this.missionId),
			this.missionConfig.readTeamConfig(this.missionId),
		]);
		const costByAgent = new Map(
			snapshot.map((a) => [a.agentId, a.lifetimeCostUsd + a.turnCostUsd]),
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
			missionTotalUsd: missionLifetimeCostUsd(snapshot),
			maxCostUsd: liveConfig?.mission.maxCostUsd ?? null,
			budgetPaused: this.budgetPaused,
			agents: this.accumulator.agents().map((a) => ({
				agentId: a.agentId,
				input: a.input,
				output: a.output,
				cacheRead: a.cacheRead,
				llmCalls: a.llmCalls,
				costUsd: costByAgent.get(a.agentId) ?? a.costUsd,
			})),
		};
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────

export const MAX_BODY_BYTES = MAILBOX_MAX_BODY_BYTES;

/** Recursively add a file or directory subtree to a zip, paths relative to `base`. */
export function addToZip(zip: JSZip, abs: string, base: string): void {
	const stat = statSync(abs);
	if (stat.isDirectory()) {
		for (const name of readdirSync(abs)) {
			// Skip the git metadata dir — it bloats the archive and isn't a deliverable.
			if (name === ".git") continue;
			addToZip(zip, join(abs, name), base);
		}
	} else {
		const rel = relative(base, abs) || basename(abs);
		zip.file(rel, readFileSync(abs));
	}
}

export function readBody(
	req: IncomingMessage,
	maxBytes: number = MAX_BODY_BYTES,
): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		let bytes = 0;
		req.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > maxBytes) {
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
