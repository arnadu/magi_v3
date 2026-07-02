/**
 * Copilot HTTP + SSE routes.
 *
 * POST /api/copilot/message   — inject an operator message into the copilot mailbox
 * GET  /api/copilot/events    — SSE stream of copilot events (messages, actions, etc.)
 * POST /api/copilot/confirm   — confirm and execute a proposed action
 * POST /api/copilot/dismiss   — dismiss a pending action without executing
 *
 * Each authenticated user gets an isolated copilot daemon (missionId = "copilot-{userId}")
 * started lazily on first message. SSE events are routed per-user.
 */

import { randomUUID } from "node:crypto";
import { parseTeamConfig } from "@magi/agent-config";
import { createMongoMailboxRepository } from "@magi/agent-runtime-worker";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { type Collection, type Db, ObjectId } from "mongodb";
import {
	type CopilotDaemonHandle,
	startCopilotDaemon,
} from "./copilot-daemon.js";
import type { PendingAction, PendingActionsStore } from "./copilot-tools.js";
import {
	provisionMission,
	resumeMission,
	suspendMission,
} from "./fly-machines.js";
import { deriveMonitorToken } from "./monitor-token.js";
import {
	getNextTemplateVersion,
	getTemplate,
	type MissionTemplate,
} from "./templates.js";

// ---------------------------------------------------------------------------
// Per-user SSE event bus
// ---------------------------------------------------------------------------

export class CopilotEventBus {
	private readonly clients = new Map<string, Set<Response>>();

	addClient(userId: string, res: Response): void {
		if (!this.clients.has(userId)) this.clients.set(userId, new Set());
		this.clients.get(userId)?.add(res);
	}

	removeClient(userId: string, res: Response): void {
		this.clients.get(userId)?.delete(res);
	}

	/** Push an event only to SSE clients belonging to userId. */
	push(userId: string, type: string, data: unknown): void {
		const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
		const set = this.clients.get(userId) ?? new Set();
		for (const res of set) {
			try {
				res.write(payload);
			} catch {
				set.delete(res);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createCopilotRouter(
	db: Db,
	repoRoot: string,
	pending: PendingActionsStore,
): Router {
	const router = createRouter();
	const eventBus = new CopilotEventBus();
	const modelId = process.env.MODEL ?? "claude-sonnet-4-6";

	// userId → running daemon handle (lazy-started on first message)
	const runningDaemons = new Map<string, CopilotDaemonHandle>();

	function ensureCopilotRunning(userId: string): void {
		if (runningDaemons.has(userId)) return;
		const missionId = `copilot-${userId}`;
		const handle = startCopilotDaemon(
			db,
			repoRoot,
			modelId,
			(type, data) => eventBus.push(userId, type, data),
			pending,
			missionId,
		);
		runningDaemons.set(userId, handle);
	}

	// ── POST /api/copilot/message ─────────────────────────────────────────────

	router.post("/message", async (req: Request, res: Response) => {
		const { subject, body } = req.body as {
			subject?: string;
			body?: string;
		};
		if (!body || typeof body !== "string") {
			res.status(400).json({ error: "body is required" });
			return;
		}

		// Post BEFORE starting the daemon (not after): on a cold start,
		// startCopilotDaemon's watch loop checks for unread mail before it opens
		// its Change Stream, so a message that already exists in the mailbox is
		// always seen — no dependency on exactly when the stream becomes live.
		// Reversed, a message inserted right after the daemon starts could race
		// ahead of the stream actually being open and be silently missed (the
		// daemon is otherwise event-only, so a missed wake-up looks like the
		// copilot never responding).
		const missionId = `copilot-${req.userId}`;
		const mailboxRepo = createMongoMailboxRepository(db, missionId);
		const msg = await mailboxRepo.post({
			missionId,
			from: "user",
			to: ["copilot"],
			subject: subject ?? "(no subject)",
			body,
		});

		ensureCopilotRunning(req.userId);

		res.json({ ok: true, id: msg.id });
	});

	// ── GET /api/copilot/usage ───────────────────────────────────────────────

	router.get("/usage", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		const [agg] = await db
			.collection("llmCallLog")
			.aggregate([
				{ $match: { missionId } },
				{
					$group: {
						_id: null,
						calls: { $sum: 1 },
						inputTokens: { $sum: "$usage.inputTokens" },
						outputTokens: { $sum: "$usage.outputTokens" },
						cacheReadTokens: { $sum: "$usage.cacheReadTokens" },
						costUsd: { $sum: "$usage.cost.totalCostUsd" },
					},
				},
			])
			.toArray();
		res.json(
			agg ?? {
				calls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				costUsd: 0,
			},
		);
	});

	// ── GET /api/copilot/history ──────────────────────────────────────────────
	// The mailbox already stores both sides of the conversation:
	//   operator → copilot:  { from: "user",    to: ["copilot"] }
	//   copilot  → operator: { from: "copilot", to: ["user"]    }
	// No separate collection needed.

	router.get("/history", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		const raw = await db
			.collection("mailbox")
			.find({
				missionId,
				$or: [{ from: "user" }, { to: "user" }],
			})
			.sort({ timestamp: -1 })
			.limit(50)
			.toArray();

		const entries = raw.reverse().map((m) => ({
			role: m.from === "user" ? "user" : "assistant",
			body: m.body as string,
			subject: m.subject as string,
			timestamp: m.timestamp,
		}));
		res.json(entries);
	});

	// ── GET /api/copilot/events ───────────────────────────────────────────────
	// Token is already verified by requireAuth via ?token= query param.

	router.get("/events", (req: Request, res: Response) => {
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.flushHeaders();

		// Keepalive ping every 25 s to prevent proxy timeouts.
		const keepalive = setInterval(() => {
			try {
				res.write(": ping\n\n");
			} catch {
				clearInterval(keepalive);
			}
		}, 25_000);

		eventBus.addClient(req.userId, res);

		req.on("close", () => {
			clearInterval(keepalive);
			eventBus.removeClient(req.userId, res);
		});
	});

	// ── POST /api/copilot/confirm ─────────────────────────────────────────────

	router.post("/confirm", async (req: Request, res: Response) => {
		const { pendingActionId } = req.body as { pendingActionId?: string };
		if (!pendingActionId) {
			res.status(400).json({ error: "pendingActionId is required" });
			return;
		}

		const action = pending.get(pendingActionId);
		if (!action) {
			res
				.status(404)
				.json({ error: "Pending action not found or already executed" });
			return;
		}

		if (!req.isAdmin && action.userId !== req.userId) {
			res.status(403).json({ error: "Forbidden" });
			return;
		}

		pending.delete(pendingActionId);

		try {
			const result = await executeAction(db, action, req.userId);
			eventBus.push(req.userId, "copilot-action-result", {
				id: pendingActionId,
				ok: true,
				result,
			});
			res.json({ ok: true, result });
		} catch (e) {
			const msg = (e as Error).message;
			eventBus.push(req.userId, "copilot-action-result", {
				id: pendingActionId,
				ok: false,
				error: msg,
			});
			res.status(500).json({ error: msg });
		}
	});

	// ── POST /api/copilot/dismiss ─────────────────────────────────────────────

	router.post("/dismiss", (req: Request, res: Response) => {
		const { pendingActionId } = req.body as { pendingActionId?: string };
		if (!pendingActionId) {
			res.status(400).json({ error: "pendingActionId is required" });
			return;
		}
		const action = pending.get(pendingActionId);
		if (action && !req.isAdmin && action.userId !== req.userId) {
			res.status(403).json({ error: "Forbidden" });
			return;
		}
		pending.delete(pendingActionId);
		res.json({ ok: true });
	});

	return router;
}

// ---------------------------------------------------------------------------
// Action executor
// ---------------------------------------------------------------------------

interface MissionDoc {
	missionId: string;
	userId: string;
	name: string;
	teamConfig: string;
	machineId?: string;
	privateIp?: string;
	volumeId?: string;
	status: string;
	createdAt: Date;
	updatedAt: Date;
}

async function executeAction(
	db: Db,
	action: PendingAction,
	userId: string,
): Promise<string> {
	const payload = action.payload as Record<string, unknown>;
	const missions = db.collection<MissionDoc>("missions");
	const now = new Date();

	switch (action.type) {
		case "launch_mission": {
			const missionId = payload.missionId as string;
			const name = (payload.name as string | undefined) ?? missionId;
			const templateId = payload.templateId as string;

			const template = await getTemplate(db, templateId);
			if (!template) throw new Error(`Template "${templateId}" not found`);

			const existing = await missions.findOne({ missionId });
			if (existing) throw new Error(`Mission "${missionId}" already exists`);

			const handle = await provisionMission(missionId, templateId, {
				teamConfigYaml: template.teamConfigYaml,
				teamFiles: template.teamFiles,
			});

			await missions.insertOne({
				missionId,
				userId,
				name,
				teamConfig: templateId,
				machineId: handle.machineId,
				privateIp: handle.privateIp,
				volumeId: handle.volumeId,
				status: "running",
				createdAt: now,
				updatedAt: now,
			});
			return `Mission "${missionId}" launched (machine: ${handle.machineId})`;
		}

		case "suspend_mission": {
			const missionId = payload.missionId as string;
			const mission = await missions.findOne({ missionId, userId });
			if (!mission?.machineId)
				throw new Error(`Mission "${missionId}" has no machine`);
			await suspendMission(mission.machineId);
			await missions.updateOne(
				{ missionId },
				{ $set: { status: "suspended", updatedAt: now } },
			);
			return `Mission "${missionId}" suspended`;
		}

		case "resume_mission": {
			const missionId = payload.missionId as string;
			const mission = await missions.findOne({ missionId, userId });
			if (!mission?.machineId)
				throw new Error(`Mission "${missionId}" has no machine`);
			await resumeMission(mission.machineId);
			await missions.updateOne(
				{ missionId },
				{ $set: { status: "running", updatedAt: now } },
			);
			return `Mission "${missionId}" resumed`;
		}

		case "write_mission_file": {
			const missionId = payload.missionId as string;
			const path = payload.path as string;
			const content = payload.content as string;
			const agentId = payload.agentId as string | undefined;

			const mission = await missions.findOne({ missionId, userId });
			if (!mission?.privateIp)
				throw new Error(`Mission "${missionId}" has no private IP`);

			const endpoint = agentId
				? `/files/workdir/${encodeURIComponent(agentId)}/write`
				: "/files/shared/write";

			const monitorToken = deriveMonitorToken(missionId);
			const res = await fetch(`http://[${mission.privateIp}]:4000${endpoint}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(monitorToken ? { "x-monitor-token": monitorToken } : {}),
				},
				body: JSON.stringify({ path, content }),
				signal: AbortSignal.timeout(15_000),
			});
			if (!res.ok) throw new Error(`Write failed: ${res.status}`);
			return `File "${path}" written to mission "${missionId}"`;
		}

		case "save_template": {
			const id = (payload.id as string | undefined) ?? randomUUID().slice(0, 8);
			const name = payload.name as string;
			const teamConfigYaml = payload.teamConfigYaml as string;
			const fromMissionId = payload.fromMissionId as string | undefined;
			const inlineFiles = payload.teamFiles as TeamFile[] | undefined;

			// Resolve teamFiles from one of three sources:
			// 1. Inline payload (explicit replace, including [] to clear)
			// 2. Mission snapshot via fromMissionId
			// 3. Latest version in the templates collection (preserve on YAML-only edits)
			let teamFiles: TeamFile[];
			if (inlineFiles !== undefined) {
				teamFiles = inlineFiles;
			} else if (fromMissionId) {
				teamFiles = [];
			} else {
				const latest = await getTemplate(db, id);
				teamFiles = latest?.teamFiles ?? [];
			}

			// If fromMissionId is given, snapshot the running mission's sharedDir and
			// merge the files into teamFiles (inline payload takes precedence).
			if (fromMissionId) {
				const srcMission = await db
					.collection<MissionDoc>("missions")
					.findOne({ missionId: fromMissionId, userId });
				if (!srcMission?.privateIp) {
					return `save_template: mission "${fromMissionId}" not found, not owned by you, or has no running machine (must be in "running" state to snapshot files)`;
				}
				const snapped = await snapshotSharedDir(
					srcMission.privateIp,
					fromMissionId,
				);
				const existingPaths = new Set(teamFiles.map((f) => f.path));
				// Payload files take precedence; snapshot fills in everything else.
				teamFiles = [
					...teamFiles,
					...snapped.filter((f) => !existingPaths.has(f.path)),
				];
			}

			// Versioning: each save is an insertOne. Version history is free.
			const nextVersion = await getNextTemplateVersion(db, id);

			// Warn if the YAML references {{sharedDir}}/ paths but no teamFiles are
			// attached — agents will fail at runtime looking for those paths.
			const refsSharedDir = teamConfigYaml.includes("{{sharedDir}}/");
			await db.collection("templates").insertOne({
				templateId: id,
				version: nextVersion,
				name,
				teamConfigYaml,
				teamFiles,
				createdAt: now,
				createdBy: userId,
			});

			// v1 means a brand-new templateId — surface it so an unintended fork
			// (editing meant to version an existing template but the id was omitted
			// or wrong) is immediately visible rather than silently creating a copy.
			const savedAs =
				nextVersion === 1
					? `Template created as NEW template "${id}" (v1)`
					: `Template "${id}" saved as v${nextVersion}`;
			if (refsSharedDir && teamFiles.length === 0) {
				return `WARNING: ${savedAs}, but it references {{sharedDir}}/ paths and has no teamFiles attached. Agents will not find those files at runtime. To fix: re-save with fromMissionId pointing to a running mission that has those files in its sharedDir, or pass teamFiles explicitly.`;
			}
			return `${savedAs} (${teamFiles.length} teamFiles attached)`;
		}

		case "save_session_config": {
			const scMissionId = payload.missionId as string | undefined;
			const scYaml = payload.teamConfigYaml as string | undefined;
			const scFiles =
				(payload.teamFiles as
					| Array<{ path: string; content: string }>
					| undefined) ?? [];
			const scMentalMaps = payload.mentalMaps as
				| Record<string, string>
				| undefined;

			if (!scMissionId || typeof scYaml !== "string") {
				return "save_session_config: missionId and teamConfigYaml are required";
			}
			const scMission = await db
				.collection("missions")
				.findOne({ missionId: scMissionId, userId });
			if (!scMission) return `Mission ${scMissionId} not found`;
			if (scMission.status !== "suspended") {
				return `Mission ${scMissionId} must be suspended before editing config (current: ${scMission.status as string})`;
			}
			try {
				parseTeamConfig(scYaml);
			} catch (e) {
				return `Invalid team config: ${(e as Error).message}`;
			}
			await db.collection("missions").updateOne(
				{ missionId: scMissionId },
				{
					$set: {
						teamConfigYaml: scYaml,
						teamFiles: scFiles,
						updatedAt: now,
					},
				},
			);
			if (scMentalMaps) {
				const convCol = db.collection("conversationMessages");
				for (const [agentId, html] of Object.entries(scMentalMaps)) {
					const latest = await convCol.findOne(
						{
							agentId,
							missionId: scMissionId,
							mentalMapHtml: { $exists: true },
						},
						{ sort: { turnNumber: -1, seqInTurn: -1 } },
					);
					if (latest) {
						await convCol.updateOne(
							{ _id: latest._id },
							{ $set: { mentalMapHtml: html } },
						);
					}
				}
			}
			return `Session config saved for mission ${scMissionId}`;
		}

		case "restore_template_version": {
			const restoreId = payload.templateId as string;
			const restoreVersion = payload.version as number;
			const versionDoc = await db
				.collection<MissionTemplate>("templates")
				.findOne({ templateId: restoreId, version: restoreVersion });
			if (!versionDoc) {
				return `restore_template_version: version ${restoreVersion} of template "${restoreId}" not found`;
			}
			// Restore = insert a new version copying content from the old one.
			// The old version and all history remain in the collection unchanged.
			const nextVersion = await getNextTemplateVersion(db, restoreId);
			await db.collection("templates").insertOne({
				templateId: restoreId,
				version: nextVersion,
				name: versionDoc.name,
				teamConfigYaml: versionDoc.teamConfigYaml,
				teamFiles: versionDoc.teamFiles,
				createdAt: now,
				createdBy: userId,
			});
			const tf = (versionDoc.teamFiles as TeamFile[]).length;
			return `Template "${restoreId}" restored from v${restoreVersion} → new v${nextVersion} (${tf} teamFiles)`;
		}

		case "cancel_schedule": {
			const scheduleId = payload.id as string;
			const oid = new ObjectId(scheduleId);
			await db
				.collection("scheduled_messages")
				.updateOne({ _id: oid }, { $set: { status: "cancelled" } });
			return `Scheduled message "${scheduleId}" cancelled`;
		}

		case "create_schedule": {
			const missionId = payload.missionId as string;
			const to = payload.to as string[];
			const subject = payload.subject as string;
			const body = payload.body as string;
			const cron = payload.cron as string | undefined;
			const deliverAt = payload.deliverAt
				? new Date(payload.deliverAt as string)
				: new Date();
			const label = payload.label as string | undefined;

			await db.collection("scheduled_messages").insertOne({
				missionId,
				to,
				subject,
				body,
				deliverAt,
				cron,
				label,
				status: "pending",
			});
			return `Scheduled message created for mission "${missionId}"`;
		}

		case "pause_agent":
		case "resume_agent": {
			const missionId = payload.missionId as string;
			const agentId = payload.agentId as string;
			const endpoint =
				action.type === "pause_agent" ? "/pause-agent" : "/resume-agent";
			await postToMissionMonitor(missions, userId, missionId, endpoint, {
				agentId,
			});
			const verb = action.type === "pause_agent" ? "paused" : "resumed";
			return `Agent "${agentId}" ${verb} in mission "${missionId}"`;
		}

		case "set_mission_budget": {
			const missionId = payload.missionId as string;
			const capUsd = payload.capUsd as number;
			if (typeof capUsd !== "number" || capUsd <= 0) {
				throw new Error("set_mission_budget requires a positive capUsd");
			}
			await postToMissionMonitor(missions, userId, missionId, "/set-budget", {
				capUsd,
			});
			return `Mission "${missionId}" spending cap set to $${capUsd.toFixed(2)}`;
		}

		default:
			throw new Error(`Unknown action type "${action.type}"`);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TeamFile = { path: string; content: string };

/**
 * POST a JSON body to a mutating endpoint on a mission's execution-plane monitor
 * server (port 4000), scoped to the requesting user and authenticated with the
 * per-mission monitor token. Throws if the mission is unknown to the user, has
 * no private IP (not running), or the monitor returns non-2xx.
 */
async function postToMissionMonitor(
	missions: Collection<MissionDoc>,
	userId: string,
	missionId: string,
	endpoint: string,
	body: unknown,
): Promise<void> {
	const mission = await missions.findOne({ missionId, userId });
	if (!mission?.privateIp) {
		throw new Error(
			`Mission "${missionId}" is not running (no private IP) — cannot ${endpoint}`,
		);
	}
	const token = deriveMonitorToken(missionId);
	const res = await fetch(`http://[${mission.privateIp}]:4000${endpoint}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { "x-monitor-token": token } : {}),
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) {
		throw new Error(`Monitor ${endpoint} failed: HTTP ${res.status}`);
	}
}

/**
 * Recursively read a mission's sharedDir via the monitor server and return a
 * teamFiles-compatible array.
 *
 * Path translation:
 *   sharedDir/skills/_team/foo  → skills/foo   (re-deployed to _team/ by WorkspaceManager)
 *   sharedDir/GUIDE.md          → GUIDE.md     (copied to sharedDir root by WorkspaceManager)
 *
 * Skipped:
 *   skills/_platform/   — baked into the Docker image; never needs embedding
 *   skills/mission/     — agent-created during runtime; not template material
 *   .git/               — version control metadata
 *   logs/               — runtime output
 */
async function snapshotSharedDir(
	privateIp: string,
	missionId: string,
): Promise<TeamFile[]> {
	const token = deriveMonitorToken(missionId);
	const headers: Record<string, string> = token
		? { "x-monitor-token": token }
		: {};
	const base = `http://[${privateIp}]:4000`;

	const files: TeamFile[] = [];

	type MonitorFileResponse = {
		type: "dir" | "file";
		entries?: Array<{ name: string; type: "dir" | "file" }>;
		encoding?: "text" | "base64";
		content?: string;
	};

	async function monitorGet(
		path: string,
	): Promise<MonitorFileResponse | undefined> {
		try {
			const r = await fetch(
				`${base}/files/shared?path=${encodeURIComponent(path)}`,
				{ headers, signal: AbortSignal.timeout(10_000) },
			);
			if (!r.ok) return undefined;
			return (await r.json()) as MonitorFileResponse;
		} catch {
			return undefined;
		}
	}

	async function walk(urlPath: string): Promise<void> {
		const data = await monitorGet(urlPath);
		if (!data) return;

		if (data.type === "dir") {
			for (const entry of data.entries ?? []) {
				if (entry.name === ".git" || entry.name === "logs") continue;
				const child =
					urlPath === "/" ? `/${entry.name}` : `${urlPath}/${entry.name}`;
				if (urlPath === "/" && entry.name === "skills") {
					// Only descend into _team/ — skip _platform/ and mission/.
					await walk("/skills/_team");
					continue;
				}
				await walk(child);
			}
		} else if (
			data.type === "file" &&
			data.encoding === "text" &&
			data.content !== undefined
		) {
			// Convert sharedDir-relative path to teamFiles path.
			// skills/_team/foo → skills/foo  (WorkspaceManager re-deploys to _team/)
			const rel = urlPath
				.replace(/^\/skills\/_team\//, "skills/")
				.replace(/^\//, "");
			files.push({ path: rel, content: data.content });
		}
		// Binary files are skipped — not useful in templates.
	}

	await walk("/");
	return files;
}
