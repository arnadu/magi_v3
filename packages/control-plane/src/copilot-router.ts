/**
 * Copilot HTTP + SSE routes.
 *
 * POST /api/copilot/message   — inject an operator message into the copilot mailbox
 * GET  /api/copilot/events    — SSE stream of copilot events (messages, actions, etc.)
 * POST /api/copilot/confirm   — confirm and execute a proposed action
 * POST /api/copilot/dismiss   — dismiss a pending action without executing
 *
 * Each authenticated user gets an isolated copilot daemon (missionId = "copilot-{userId}")
 * started lazily on first message, or when mail arrives for it (copilot-waker.ts).
 * SSE events are routed per-user.
 */

import {
	type AgentConfig,
	type Limits,
	type MissionDoc,
	parseTeamConfig,
	storedCollection,
	type TeamConfig,
	validateTeamFiles,
} from "@magi/agent-config";
import {
	assertKnownModels,
	createMongoMailboxRepository,
	createMongoMissionConfigWriter,
} from "@magi/agent-runtime-worker";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type { Collection, Db } from "mongodb";
import { asyncRoutes } from "./async-handler.js";
import { type ActionPayload, parseActionPayload } from "./copilot-actions.js";
import { COPILOT_WORKDIR, copilotWorkdirFor } from "./copilot-daemon.js";
import { readCopilotFileNode } from "./copilot-files.js";
import { executeLaunchMission } from "./copilot-launch-actions.js";
import { createPendingActionRoutes } from "./copilot-pending-routes.js";
import type { CopilotRuntime } from "./copilot-runtime.js";
import {
	executeCancelSchedule,
	executeCreateSchedule,
} from "./copilot-schedule-actions.js";
import {
	COPILOT_AGENT_ID,
	checkCopilotSpendCap,
	readCopilotSpend,
} from "./copilot-spend.js";
import {
	flyVolumeName,
	isLocalExecution,
	listVolumes,
	provisionLocal,
} from "./fly-machines.js";
import {
	executeGithubIssueAction,
	GITHUB_ISSUE_ACTION,
	parseGithubIssuePayload,
} from "./github-issues.js";
import { provisionTracked, wakeTracked } from "./machine-lifecycle.js";
import { deriveMonitorToken } from "./monitor-token.js";
import type { PendingAction, PendingActionsStore } from "./pending-actions.js";
import { suspendMissionMachine } from "./resource-upgrade.js";
import {
	queryLlmCall,
	queryLlmCalls,
	queryTranscript,
	queryTurns,
} from "./transcript-queries.js";
import { lifetimeUsage } from "./usage-queries.js";
import {
	getCopilotModel,
	getCopilotSpendCap,
	setCopilotModel,
	setCopilotSpendCap,
} from "./users.js";

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createCopilotRouter(
	db: Db,
	pending: PendingActionsStore,
	runtime: CopilotRuntime,
): Router {
	const router = createRouter();
	const routes = asyncRoutes(router);
	const { eventBus, defaultModelId } = runtime;

	// ── POST /api/copilot/message ─────────────────────────────────────────────

	routes.post("/message", async (req: Request, res: Response) => {
		const { subject, body } = req.body as {
			subject?: string;
			body?: string;
		};
		if (!body || typeof body !== "string") {
			res.status(400).json({ error: "body is required" });
			return;
		}

		const missionId = `copilot-${req.userId}`;
		const capError = await checkCopilotSpendCap(db, req.userId);
		if (capError !== null) {
			res.status(402).json({ error: capError });
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
		const mailboxRepo = createMongoMailboxRepository(db, missionId);
		const msg = await mailboxRepo.post({
			missionId,
			from: "user",
			to: ["copilot"],
			subject: subject ?? "(no subject)",
			body,
		});

		await runtime.ensureCopilotRunning(req.userId);

		res.json({ ok: true, id: msg.id });
	});

	// ── GET/POST /api/copilot/settings ────────────────────────────────────────
	// The copilot's model is per-user today. When per-mission copilots land
	// (deferred — see GitHub #14), this resolution order extends naturally:
	// mission-level copilot model override -> this user-level setting -> the
	// MODEL env var fallback. No rework needed here for that later.

	routes.get("/settings", async (req: Request, res: Response) => {
		const model = await getCopilotModel(db, req.userId);
		res.json({
			model: model ?? defaultModelId,
			isDefault: model === undefined,
		});
	});

	routes.post("/settings", async (req: Request, res: Response) => {
		const { model } = req.body as { model?: string | null };
		if (model !== null && model !== undefined && typeof model !== "string") {
			res.status(400).json({ error: "model must be a string or null" });
			return;
		}

		// Guard against switching models mid-turn: stop() only aborts the signal
		// — it does not wait for the in-flight runAgent() call to unwind, and the
		// very next /message call starts a fresh daemon immediately, racing the
		// old one's still-in-progress final write. Found live: that race left a
		// tool_use persisted with no result (the tool never ran), permanently
		// corrupting the copilot's history — every later session failed
		// identically, regardless of which model it replayed against. Rejecting
		// here instead of aborting mid-flight is simpler and more honest than
		// trying to sequence the abort/restart correctly, and matches how the
		// operator was already retrying by hand.
		if (runtime.getDaemon(req.userId)?.isBusy()) {
			res.status(409).json({
				error:
					"Copilot is currently running a turn — wait for it to finish before changing the model.",
			});
			return;
		}

		await setCopilotModel(db, req.userId, model ?? undefined);

		// The running daemon (if any) captured the old model at startup and
		// won't pick up the change on its own — stop it so the next message
		// triggers a fresh ensureCopilotRunning() with the new model. Safe now:
		// the busy check above already ruled out an in-flight turn.
		runtime.stopDaemon(req.userId);

		res.json({ ok: true, model: model ?? defaultModelId });
	});

	// ── GET /api/copilot/usage ───────────────────────────────────────────────

	routes.get("/usage", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		res.json(await lifetimeUsage(db, missionId));
	});

	// ── GET /api/copilot/history ──────────────────────────────────────────────
	// The mailbox already stores both sides of the conversation:
	//   operator → copilot:  { from: "user",    to: ["copilot"] }
	//   copilot  → operator: { from: "copilot", to: ["user"]    }
	// No separate collection needed.

	routes.get("/history", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		const raw = await storedCollection(db, "mailbox")
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

	// ── GET /api/copilot/turns, /transcript, /llm-calls, /llm-call ─────────────
	// Same data shape as the mission Transcripts tab (`/api/missions/:id/...`),
	// but scoped directly by req.userId — no `missions` collection document
	// exists for "copilot-{userId}", so there's no ownership lookup to do; the
	// userId is already the whole scope. See transcript-queries.ts.

	routes.get("/turns", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		res.json(await queryTurns(db, missionId, COPILOT_AGENT_ID));
	});

	routes.get("/transcript", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		const turn = Number(req.query.turn);
		if (Number.isNaN(turn)) {
			res.status(400).json({ error: "turn query param required" });
			return;
		}
		res.json(await queryTranscript(db, missionId, COPILOT_AGENT_ID, turn));
	});

	routes.get("/llm-calls", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		const turn = Number(req.query.turn);
		if (Number.isNaN(turn)) {
			res.status(400).json({ error: "turn query param required" });
			return;
		}
		res.json(await queryLlmCalls(db, missionId, COPILOT_AGENT_ID, turn));
	});

	routes.get("/llm-call", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		const turn = Number(req.query.turn);
		const i = Number(req.query.i);
		if (Number.isNaN(turn) || Number.isNaN(i)) {
			res.status(400).json({ error: "turn and i query params required" });
			return;
		}
		const detail = await queryLlmCall(db, missionId, COPILOT_AGENT_ID, turn, i);
		if (!detail) {
			res.status(404).json({ error: "call not found" });
			return;
		}
		res.json(detail);
	});

	// ── GET /api/copilot/files ──────────────────────────────────────────────
	// Direct filesystem read, not a proxy — the copilot runs in-process in the
	// control-plane container, so COPILOT_WORKDIR is on this process's own
	// filesystem. See copilot-files.ts for the path-boundary/symlink guard.

	// X-TENANT3: a user sees only their own copilot's subdirectory. Admins
	// see the whole workdir, which also keeps files written before per-user
	// subdirectories existed reachable to someone.
	router.get("/files", (req: Request, res: Response) => {
		const userPath = (req.query.path as string | undefined) ?? "";
		const root = req.isAdmin
			? COPILOT_WORKDIR
			: copilotWorkdirFor(`copilot-${req.userId}`);
		const node = readCopilotFileNode(root, userPath);
		if (node === null) {
			res.status(400).json({ error: "Path outside root" });
			return;
		}
		res.json(node);
	});

	// ── GET/PATCH /api/copilot/limits ───────────────────────────────────────

	routes.get("/limits", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		const [capUsd, spentUsd] = await Promise.all([
			getCopilotSpendCap(db, req.userId),
			readCopilotSpend(db, missionId),
		]);
		res.json({ capUsd: capUsd ?? null, spentUsd });
	});

	routes.patch("/limits", async (req: Request, res: Response) => {
		const { capUsd } = req.body as { capUsd?: number | null };
		if (capUsd !== null && capUsd !== undefined && typeof capUsd !== "number") {
			res.status(400).json({ error: "capUsd must be a number or null" });
			return;
		}
		if (typeof capUsd === "number" && capUsd <= 0) {
			res.status(400).json({ error: "capUsd must be positive" });
			return;
		}
		await setCopilotSpendCap(db, req.userId, capUsd ?? undefined);
		res.json({ ok: true, capUsd: capUsd ?? null });
	});

	// ── GET /api/copilot/events ───────────────────────────────────────────────
	// Auth already ran (requireAuth is mounted above this router); the browser's
	// EventSource sends the HttpOnly session cookie with `withCredentials`.

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

	// Proposed-action confirmation, replay and dismissal (copilot-pending-routes.ts).
	router.use(
		createPendingActionRoutes({ db, pending, eventBus, executeAction }),
	);

	return router;
}

// ---------------------------------------------------------------------------
// Action executor
// ---------------------------------------------------------------------------

export async function executeAction(
	db: Db,
	action: PendingAction,
	userId: string,
): Promise<string> {
	// Re-validated at execution against the same registry that admitted it at
	// proposal time: the card showed this payload, but nothing between the
	// store and here guarantees its shape, and a stale stored action should
	// fail loudly rather than run with missing fields.
	const parsed = parseActionPayload(action.type, action.payload);
	const payload = parsed.payload as Record<string, unknown>;
	const missions = storedCollection(db, "missions");
	const now = new Date();

	switch (parsed.type) {
		case GITHUB_ISSUE_ACTION: {
			return executeGithubIssueAction(parseGithubIssuePayload(payload), {
				userId: action.userId,
			});
		}
		case "launch_mission":
			return executeLaunchMission(
				db,
				payload as ActionPayload<"launch_mission">,
				userId,
				now,
			);

		case "launch_draft": {
			const missionId = payload.missionId as string;
			const draft = await missions.findOne({ missionId, userId });
			if (!draft) throw new Error(`Mission "${missionId}" not found`);
			if (draft.status !== "draft")
				throw new Error(`Mission "${missionId}" is not a draft`);

			let validated: TeamConfig;
			try {
				validated = parseTeamConfig({
					mission: draft.mission,
					agents: draft.agents,
					missionCopilotLimits: draft.missionCopilotLimits,
				});
				assertKnownModels(validated.mission);
			} catch (e) {
				throw new Error(`Invalid team config: ${(e as Error).message}`);
			}

			try {
				const handle = isLocalExecution()
					? provisionLocal(missionId, { teamFiles: draft.teamFiles ?? [] })
					: await provisionTracked(db, missionId, {
							memoryMb: validated.mission.memoryMb,
							cpus: validated.mission.cpus,
						});
				await missions.updateOne(
					{ missionId },
					{
						$set: {
							machineId: handle.machineId,
							privateIp: handle.privateIp,
							volumeId: handle.volumeId,
							status: "running",
							updatedAt: now,
						},
					},
				);
				return `Mission "${missionId}" launched (machine: ${handle.machineId})`;
			} catch (e) {
				const errorMessage = (e as Error).message;
				console.error(
					`[copilot-router] draft launch failed { missionId: "${missionId}", error: "${errorMessage}" }`,
				);
				await missions.updateOne(
					{ missionId },
					{ $set: { status: "error", errorMessage, updatedAt: now } },
				);
				throw new Error(
					`Launch failed for mission "${missionId}": ${errorMessage}`,
				);
			}
		}

		case "suspend_mission": {
			const missionId = payload.missionId as string;
			const mission = await missions.findOne({ missionId, userId });
			if (!mission?.machineId)
				throw new Error(`Mission "${missionId}" has no machine`);
			await suspendMissionMachine(db, {
				missionId,
				machineId: mission.machineId,
			});
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

			// A mission left in "error" status (e.g. after a resume that failed
			// because its volumeId had drifted — issue #62) has no guarantee its
			// machineId still points to a real Fly machine; wakeTracked starts it
			// when it exists and re-provisions on the volume when it is gone —
			// without that, this action could never recover a mission
			// fix_mission_volume just fixed, since its old machineId is exactly
			// the one that got deleted.
			const woke = await wakeTracked(db, {
				missionId,
				machineId: mission.machineId,
				volumeId: mission.volumeId,
				mission: mission.mission,
			});
			return woke.reprovisioned
				? `Mission "${missionId}" resumed (its machine had been destroyed — reprovisioned fresh: ${woke.machineId})`
				: `Mission "${missionId}" resumed`;
		}

		case "fix_mission_volume": {
			const missionId = payload.missionId as string;
			const mission = await missions.findOne({ missionId, userId });
			if (!mission) throw new Error(`Mission "${missionId}" not found`);

			// The candidate is derived server-side from Fly's own volume list and
			// the existing naming convention (flyVolumeName) — the LLM never
			// supplies a volume ID directly. Letting it do so would let a
			// compromised or confused copilot attach any mission's volume to any
			// other mission, a cross-tenant risk. Refusing on ambiguity (rather
			// than guessing) keeps this to "fix the one case we can verify."
			const expectedName = flyVolumeName(missionId);
			const [allVolumes, otherMissions] = await Promise.all([
				listVolumes(),
				missions
					.find({ missionId: { $ne: missionId }, status: { $ne: "destroyed" } })
					.toArray(),
			]);
			const claimedElsewhere = new Set(
				otherMissions.map((m) => m.volumeId).filter((id): id is string => !!id),
			);
			const candidates = allVolumes.filter(
				(v) => v.name === expectedName && !claimedElsewhere.has(v.id),
			);

			if (candidates.length === 0) {
				throw new Error(
					`No unclaimed Fly volume named "${expectedName}" found for mission "${missionId}" — check \`flyctl volumes list\` manually.`,
				);
			}
			if (candidates.length > 1) {
				throw new Error(
					`Ambiguous: ${candidates.length} unclaimed Fly volumes named "${expectedName}" found (ids: ${candidates.map((c) => c.id).join(", ")}) — resolve manually via \`flyctl volumes list\`.`,
				);
			}

			const [volume] = candidates;
			await missions.updateOne(
				{ missionId },
				{ $set: { volumeId: volume.id, updatedAt: now } },
			);
			return `mission.volumeId for "${missionId}" corrected to ${volume.id} (matched by name "${expectedName}"). Propose "resume_mission" next to bring the mission back up.`;
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

		case "save_session_config": {
			const scMissionId = payload.missionId as string | undefined;
			const scMissionPatch = payload.mission as
				| Partial<TeamConfig["mission"]>
				| undefined;
			const scAgentsPatch = payload.agents as AgentConfig[] | undefined;
			const scMissionCopilotLimitsPatch = payload.missionCopilotLimits as
				| Limits
				| undefined;
			const scTeamFilesProvided = payload.teamFiles !== undefined;
			const scFiles =
				(payload.teamFiles as
					| Array<{ path: string; content: string }>
					| undefined) ?? [];
			const scMentalMaps = payload.mentalMaps as
				| Record<string, string>
				| undefined;

			if (!scMissionId) {
				throw new Error("save_session_config: missionId is required");
			}
			const scMission = await missions.findOne({
				missionId: scMissionId,
				userId,
			});
			if (!scMission) throw new Error(`Mission ${scMissionId} not found`);
			if (scMission.status !== "suspended") {
				throw new Error(
					`Mission ${scMissionId} must be suspended before editing config (current: ${scMission.status})`,
				);
			}
			if (!scMission.mission || !scMission.agents) {
				throw new Error(
					`Mission ${scMissionId} has no structured config stored`,
				);
			}

			const nextMission = {
				...scMission.mission,
				...scMissionPatch,
				id: scMissionId,
			};
			const nextAgents = scAgentsPatch
				? [
						...scMission.agents.filter(
							(a) => !scAgentsPatch.some((p) => p.id === a.id),
						),
						...scAgentsPatch,
					]
				: scMission.agents;
			const nextMissionCopilotLimits =
				scMissionCopilotLimitsPatch ?? scMission.missionCopilotLimits;

			let scValidated: TeamConfig;
			try {
				scValidated = parseTeamConfig({
					mission: nextMission,
					agents: nextAgents,
					missionCopilotLimits: nextMissionCopilotLimits,
				});
				assertKnownModels(scValidated.mission);
			} catch (e) {
				throw new Error(`Invalid team config: ${(e as Error).message}`);
			}
			// TF1/CHAIN-A: scFiles is copilot/LLM-authored and reaches the
			// daemon's filesystem unvalidated otherwise (team-files-sync.ts).
			if (scTeamFilesProvided) validateTeamFiles(scFiles);

			await createMongoMissionConfigWriter(db).write(
				scMissionId,
				{
					mission: scValidated.mission,
					agents: scValidated.agents,
					missionCopilotLimits: scValidated.missionCopilotLimits,
				},
				"copilot",
			);
			if (scTeamFilesProvided) {
				await missions.updateOne(
					{ missionId: scMissionId },
					{ $set: { teamFiles: scFiles, updatedAt: now } },
				);
			}
			if (scMentalMaps) {
				const convCol = storedCollection(db, "conversationMessages");
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

		case "cancel_schedule":
			return executeCancelSchedule(
				db,
				payload as ActionPayload<"cancel_schedule">,
				userId,
			);

		case "create_schedule":
			return executeCreateSchedule(
				db,
				payload as ActionPayload<"create_schedule">,
				userId,
				now,
			);

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
