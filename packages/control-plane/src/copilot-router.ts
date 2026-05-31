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
import { type Db, ObjectId } from "mongodb";
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
import { getTemplate } from "./templates.js";

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

		ensureCopilotRunning(req.userId);

		const missionId = `copilot-${req.userId}`;
		const mailboxRepo = createMongoMailboxRepository(db, missionId);
		const msg = await mailboxRepo.post({
			missionId,
			from: "user",
			to: ["copilot"],
			subject: subject ?? "(no subject)",
			body,
		});
		res.json({ ok: true, id: msg.id });
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
			const mission = await missions.findOne({ missionId });
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
			const mission = await missions.findOne({ missionId });
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

			const mission = await missions.findOne({ missionId });
			if (!mission?.privateIp)
				throw new Error(`Mission "${missionId}" has no private IP`);

			const endpoint = agentId
				? `/files/workdir/${encodeURIComponent(agentId)}/write`
				: "/files/shared/write";

			const res = await fetch(`http://[${mission.privateIp}]:4000${endpoint}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
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
			const teamFiles =
				(payload.teamFiles as
					| Array<{
							path: string;
							content: string;
					  }>
					| undefined) ?? [];

			await db.collection<{ _id: string }>("templates").updateOne(
				{ _id: id },
				{
					$set: { name, teamConfigYaml, teamFiles, updatedAt: now },
					$setOnInsert: { createdAt: now },
				},
				{ upsert: true },
			);
			return `Template "${id}" saved`;
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
				.findOne({ missionId: scMissionId });
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

		default:
			throw new Error(`Unknown action type "${action.type}"`);
	}
}
