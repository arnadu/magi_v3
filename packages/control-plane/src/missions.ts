/**
 * Mission CRUD + lifecycle routes.
 *
 * POST   /api/missions              — provision a new mission
 * GET    /api/missions              — list all missions
 * GET    /api/missions/:id          — get one mission
 * GET    /api/missions/:id/config   — get structured config + live mental maps
 * PUT    /api/missions/:id/config   — update structured config + mental maps (suspended only)
 * POST   /api/missions/:id/suspend  — stop execution machine
 * POST   /api/missions/:id/resume   — start execution machine
 * DELETE /api/missions/:id          — destroy machine + volume (irreversible)
 */

import { randomUUID } from "node:crypto";
import {
	type AgentConfig,
	type Limits,
	LimitsSchema,
	parseTeamConfig,
	type TeamConfig,
} from "@magi/agent-config";
import {
	createMongoAgentStatsRepository,
	createMongoMissionConfigWriter,
	DEFAULT_SOFT_LIMITS,
} from "@magi/agent-runtime-worker";
import type { Request, Router } from "express";
import { Router as createRouter } from "express";
import type { Collection, Db } from "mongodb";
import {
	deleteMachine,
	destroyLocal,
	destroyMission,
	getMachineState,
	isLocalExecution,
	provisionLocal,
	provisionMission,
	suspendMission,
} from "./fly-machines.js";
import { deriveMonitorToken } from "./monitor-token.js";
import { getTemplate } from "./templates.js";

interface MissionDoc {
	missionId: string;
	/** Firebase UID of the owner, or "admin" for CONTROL_API_KEY-created missions. */
	userId: string;
	name: string;
	teamConfig: string;
	/** Structured config (ADR-0021) — the live source of truth. */
	mission?: TeamConfig["mission"];
	agents?: AgentConfig[];
	missionCopilotLimits?: Limits;
	/** Team files (skills, etc.) stored at provision time; updated on config edit. */
	teamFiles?: Array<{ path: string; content: string }>;
	machineId?: string;
	privateIp?: string;
	volumeId?: string;
	status: "provisioning" | "running" | "suspended" | "destroyed" | "error";
	/** Set when status === "error"; cleared on successful resume. */
	errorMessage?: string;
	createdAt: Date;
	updatedAt: Date;
}

/** Admin sees all missions; regular users see only their own. */
function userFilter(req: Request): Partial<MissionDoc> {
	return req.isAdmin ? {} : { userId: req.userId };
}

// ---------------------------------------------------------------------------
// Limits (cockpit Limits panel) — GET/PATCH read+write current & configured
// budget/limit state. Every limit (mission-wide cap, per-agent, mission
// copilot's own) lives in the mission doc's structured `mission`/`agents`/
// `missionCopilotLimits` fields (ADR-0021). Exported as plain functions,
// separate from the Express handlers that wrap them, so tests can call them
// directly against real Mongo (this repo has no supertest-equivalent
// HTTP-route test pattern — see copilot-tools.integration.test.ts for the
// precedent this follows).
// ---------------------------------------------------------------------------

export interface AgentLimitsRow {
	agentId: string;
	limits: Partial<Limits>;
	effectiveSoft: {
		warnLlmCallsPerTurn: number;
		warnPeakContextTokens: number;
		warnToolErrorsPerTurn: number;
		warnConsecutiveZeroOutputTurns: number;
	};
	live: {
		lifetimeCostUsd: number | null;
		lifetimeLlmCallCount: number | null;
		consecutiveZeroOutputTurns: number | null;
		mostRecentTurn: {
			turnNumber: number;
			llmCallCount: number;
			costUsd: number;
			peakContextTokens: number;
			toolErrorsTotal: number;
		} | null;
	};
}

export interface LimitsData {
	mission: {
		maxCostUsd: number | null;
		missionTotalUsd: number | null;
		budgetPaused: boolean | null;
	};
	agents: AgentLimitsRow[];
	missionRunning: boolean;
}

interface RouteResult {
	status: number;
	body: unknown;
}

function effectiveSoftOf(
	limits: Partial<Limits>,
): AgentLimitsRow["effectiveSoft"] {
	return {
		warnLlmCallsPerTurn:
			limits.warnLlmCallsPerTurn ?? DEFAULT_SOFT_LIMITS.warnLlmCallsPerTurn,
		warnPeakContextTokens:
			limits.warnPeakContextTokens ?? DEFAULT_SOFT_LIMITS.warnPeakContextTokens,
		warnToolErrorsPerTurn:
			limits.warnToolErrorsPerTurn ?? DEFAULT_SOFT_LIMITS.warnToolErrorsPerTurn,
		warnConsecutiveZeroOutputTurns:
			limits.warnConsecutiveZeroOutputTurns ??
			DEFAULT_SOFT_LIMITS.warnConsecutiveZeroOutputTurns,
	};
}

/** Audit-trail mailbox post for every Limits-panel edit — operator-initiated
 * (the panel, not an agent tool), so `from`/`to` mirror the existing
 * `/messages/send` route's human-to-agent convention, not SaveMissionConfig's
 * agent-to-human one (that's the opposite direction: an agent informing the
 * operator of its own action). Gives the mission copilot situational
 * awareness of externally-changed limits, relevant to its resource-oversight
 * role. */
async function postLimitsAudit(
	db: Db,
	missionId: string,
	subject: string,
	body: string,
): Promise<void> {
	await db.collection("mailbox").insertOne({
		id: randomUUID(),
		missionId,
		from: "user",
		to: ["mission-copilot"],
		subject,
		body,
		timestamp: new Date(),
		readBy: [],
	});
}

export async function readLimits(
	col: Collection<MissionDoc>,
	db: Db,
	missionId: string,
	filter: Partial<MissionDoc>,
): Promise<RouteResult> {
	const mission = await col.findOne({ missionId, ...filter });
	if (!mission) return { status: 404, body: { error: "Not found" } };
	if (!mission.mission || !mission.agents) {
		return {
			status: 404,
			body: { error: "No config stored for this mission" },
		};
	}

	let teamConfig: TeamConfig;
	try {
		teamConfig = parseTeamConfig({
			mission: mission.mission,
			agents: mission.agents,
			missionCopilotLimits: mission.missionCopilotLimits,
		});
	} catch (e) {
		return {
			status: 500,
			body: { error: `Stored config is invalid: ${(e as Error).message}` },
		};
	}

	const missionRunning = mission.status === "running";

	// Lifetime numbers — own query, not the existing GET /mission-stats route
	// (its projection excludes consecutiveZeroOutputTurns, and that route is
	// monitor-proxied so it's unreachable while suspended anyway). Call count
	// and the zero-output streak have no live/in-flight equivalent worth
	// tracking (they're inherently "as of the last completed turn"), so those
	// two still come straight from missionStats.
	const statsDocs = await db
		.collection("missionStats")
		.find(
			{ missionId },
			{
				projection: {
					agentId: 1,
					lifetimeLlmCallCount: 1,
					consecutiveZeroOutputTurns: 1,
					_id: 0,
				},
			},
		)
		.toArray();
	const statsByAgent = new Map(statsDocs.map((d) => [d.agentId as string, d]));

	// The dollar figure, by contrast, IS what a limit is actually checked
	// against — reuse the exact same persisted-lifetime + in-flight-turn
	// combination enforceLimits/the mission-wide cap check use
	// (readMissionSnapshot, agent-stats.ts), rather than a second,
	// independent sum that only reads the persisted total and can therefore
	// under-report a live mission by the cost of whatever turn is currently
	// in flight for that agent.
	const snapshot =
		await createMongoAgentStatsRepository(db).readMissionSnapshot(missionId);
	const costByAgent = new Map(
		snapshot.map((s) => [s.agentId, s.lifetimeCostUsd + s.turnCostUsd]),
	);

	// Authored roster + the synthesized mission-copilot row (daemon-injected,
	// never in agents[] — its limits live in the top-level missionCopilotLimits
	// field instead).
	const roster: Array<{ agentId: string; limits: Partial<Limits> }> = [
		...teamConfig.agents.map((a) => ({
			agentId: a.id,
			limits: a.limits ?? {},
		})),
		{
			agentId: "mission-copilot",
			limits: teamConfig.missionCopilotLimits ?? {},
		},
	];

	const agents: AgentLimitsRow[] = [];
	for (const { agentId, limits } of roster) {
		const mostRecentDocs = await db
			.collection("agentTurnStats")
			.find({ missionId, agentId, completedAt: { $exists: true } })
			.sort({ turnNumber: -1 })
			.limit(1)
			.toArray();
		const mrt = mostRecentDocs[0];
		const stats = statsByAgent.get(agentId);
		agents.push({
			agentId,
			limits,
			effectiveSoft: effectiveSoftOf(limits),
			live: {
				lifetimeCostUsd: costByAgent.get(agentId) ?? null,
				lifetimeLlmCallCount: (stats?.lifetimeLlmCallCount as number) ?? null,
				consecutiveZeroOutputTurns:
					(stats?.consecutiveZeroOutputTurns as number) ?? null,
				mostRecentTurn: mrt
					? {
							turnNumber: mrt.turnNumber as number,
							llmCallCount: (mrt.llmCallCount as number) ?? 0,
							costUsd: (mrt.costUsd as number) ?? 0,
							peakContextTokens: (mrt.peakContextTokens as number) ?? 0,
							toolErrorsTotal: Object.values(
								(mrt.toolErrors ?? {}) as Record<string, number>,
							).reduce((a, b) => a + b, 0),
						}
					: null,
			},
		});
	}

	// Best-effort — the mission's own live state, only reachable while running.
	let missionTotalUsd: number | null = null;
	let budgetPaused: boolean | null = null;
	if (missionRunning && mission.privateIp) {
		try {
			const res = await fetch(`http://[${mission.privateIp}]:4000/status`, {
				signal: AbortSignal.timeout(5_000),
			});
			if (res.ok) {
				const s = (await res.json()) as {
					missionTotalUsd?: number;
					budgetPaused?: boolean;
				};
				missionTotalUsd = s.missionTotalUsd ?? null;
				budgetPaused = s.budgetPaused ?? null;
			}
		} catch {
			// Monitor unreachable — leave both null rather than fail the route.
		}
	}

	const data: LimitsData = {
		mission: {
			maxCostUsd: teamConfig.mission.maxCostUsd ?? null,
			missionTotalUsd,
			budgetPaused,
		},
		agents,
		missionRunning,
	};
	return { status: 200, body: data };
}

export async function writeMissionCap(
	col: Collection<MissionDoc>,
	db: Db,
	missionId: string,
	filter: Partial<MissionDoc>,
	maxCostUsd: number,
): Promise<RouteResult> {
	if (!(maxCostUsd > 0)) {
		return { status: 400, body: { error: "maxCostUsd must be > 0" } };
	}
	const mission = await col.findOne({ missionId, ...filter });
	if (!mission) return { status: 404, body: { error: "Not found" } };
	if (!mission.mission || !mission.agents) {
		return {
			status: 404,
			body: { error: "No config stored for this mission" },
		};
	}

	let validated: TeamConfig;
	try {
		validated = parseTeamConfig({
			mission: { ...mission.mission, maxCostUsd },
			agents: mission.agents,
			missionCopilotLimits: mission.missionCopilotLimits,
		});
	} catch (e) {
		return {
			status: 400,
			body: { error: `Invalid team config: ${(e as Error).message}` },
		};
	}

	await createMongoMissionConfigWriter(db).write(
		missionId,
		{
			mission: validated.mission,
			agents: validated.agents,
			missionCopilotLimits: validated.missionCopilotLimits,
		},
		"user",
	);

	// Best-effort live apply — the persisted YAML write above is the source
	// of truth going forward regardless of whether this succeeds.
	let liveUpdateApplied = false;
	if (mission.status === "running" && mission.privateIp) {
		try {
			const token = deriveMonitorToken(missionId);
			const res = await fetch(`http://[${mission.privateIp}]:4000/set-budget`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(token ? { "x-monitor-token": token } : {}),
				},
				body: JSON.stringify({ capUsd: maxCostUsd }),
				signal: AbortSignal.timeout(10_000),
			});
			liveUpdateApplied = res.ok;
		} catch {
			// Best-effort.
		}
	}

	await postLimitsAudit(
		db,
		missionId,
		"Mission spend cap changed",
		`Operator set the mission's spend cap to $${maxCostUsd.toFixed(2)} via the cockpit Limits panel.` +
			(liveUpdateApplied
				? " Applied immediately."
				: mission.status === "running"
					? " Will apply on the mission's next spend check (ADR-0018 — no restart needed); " +
						"if the mission is currently paused for budget, it will stay paused until " +
						"the operator resumes it or extends the budget again."
					: " Will apply the next time the mission is resumed."),
	);

	return { status: 200, body: { ok: true, maxCostUsd, liveUpdateApplied } };
}

export async function writeAgentLimits(
	col: Collection<MissionDoc>,
	db: Db,
	missionId: string,
	filter: Partial<MissionDoc>,
	agentId: string,
	limits: Limits | null,
): Promise<RouteResult> {
	if (limits !== null) {
		const parsed = LimitsSchema.safeParse(limits);
		if (!parsed.success) {
			return {
				status: 400,
				body: { error: `Invalid limits: ${parsed.error.message}` },
			};
		}
	}
	const mission = await col.findOne({ missionId, ...filter });
	if (!mission) return { status: 404, body: { error: "Not found" } };
	if (!mission.mission || !mission.agents) {
		return {
			status: 404,
			body: { error: "No config stored for this mission" },
		};
	}

	// mission-copilot is daemon-injected and never appears in agents[] — its
	// limits live in the top-level missionCopilotLimits field instead.
	let nextMissionCopilotLimits = mission.missionCopilotLimits;
	let nextAgents = mission.agents;
	if (agentId === "mission-copilot") {
		nextMissionCopilotLimits = limits ?? undefined;
	} else {
		const target = mission.agents.find((a) => a.id === agentId);
		if (!target) {
			return {
				status: 404,
				body: { error: `Agent "${agentId}" not found in team config` },
			};
		}
		nextAgents = mission.agents.map((a) =>
			a.id === agentId ? { ...a, limits: limits ?? undefined } : a,
		);
	}

	let validated: TeamConfig;
	try {
		validated = parseTeamConfig({
			mission: mission.mission,
			agents: nextAgents,
			missionCopilotLimits: nextMissionCopilotLimits,
		});
	} catch (e) {
		return {
			status: 400,
			body: { error: `Invalid team config: ${(e as Error).message}` },
		};
	}

	// teamFiles is never read or written here — this route can't reproduce
	// the earlier SaveMissionConfig teamFiles-wipe bug by construction.
	await createMongoMissionConfigWriter(db).write(
		missionId,
		{
			mission: validated.mission,
			agents: validated.agents,
			missionCopilotLimits: validated.missionCopilotLimits,
		},
		"user",
	);

	await postLimitsAudit(
		db,
		missionId,
		`Agent "${agentId}" limits updated`,
		`Operator updated limits for "${agentId}" via the cockpit Limits panel. ` +
			"If the mission is running, this applies on the agent's next limit check " +
			"(ADR-0018 — no restart needed).",
	);

	return { status: 200, body: { ok: true, agentId, limits } };
}

export function createMissionsRouter(db: Db): Router {
	const router = createRouter();
	const col = db.collection<MissionDoc>("missions");

	// Create userId index on first router mount (idempotent).
	void col.createIndex({ userId: 1, createdAt: -1 });

	// List missions (scoped to current user unless admin).
	router.get("/", async (req, res) => {
		const missions = await col
			.find(userFilter(req), { sort: { createdAt: -1 } })
			.toArray();
		res.json(missions);
	});

	// Per-mission telemetry — registered before /:id to avoid route shadowing.
	router.get("/stats", async (req, res) => {
		const missions = await col
			.find(
				{ ...userFilter(req), status: { $ne: "destroyed" } },
				{ projection: { missionId: 1, _id: 0 } },
			)
			.toArray();
		const missionIds = missions.map((m) => m.missionId);

		const now = new Date();
		const oneHourAgo = new Date(now.getTime() - 3_600_000);
		const todayStart = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate(),
		);

		const [unreadCounts, spendDocs, lastActivityDocs] = await Promise.all([
			db
				.collection("mailbox")
				.aggregate([
					{ $match: { missionId: { $in: missionIds }, read: false } },
					{ $group: { _id: "$missionId", count: { $sum: 1 } } },
				])
				.toArray(),
			db
				.collection("llmCallLog")
				.aggregate([
					{ $match: { missionId: { $in: missionIds } } },
					{
						$group: {
							_id: "$missionId",
							total: { $sum: "$cost" },
							today: {
								$sum: {
									$cond: [{ $gte: ["$createdAt", todayStart] }, "$cost", 0],
								},
							},
							lastHour: {
								$sum: {
									$cond: [{ $gte: ["$createdAt", oneHourAgo] }, "$cost", 0],
								},
							},
						},
					},
				])
				.toArray(),
			db
				.collection("conversationMessages")
				.aggregate([
					{ $match: { missionId: { $in: missionIds } } },
					{ $sort: { createdAt: -1 } },
					{
						$group: {
							_id: "$missionId",
							lastActivity: { $first: "$createdAt" },
							snippet: { $first: "$content" },
						},
					},
				])
				.toArray(),
		]);

		const stats: Record<string, object> = {};
		for (const id of missionIds) {
			const u = unreadCounts.find((d) => d._id === id);
			const s = spendDocs.find((d) => d._id === id);
			const a = lastActivityDocs.find((d) => d._id === id);
			stats[id] = {
				unread: u?.count ?? 0,
				spendTotal: s?.total ?? 0,
				spendToday: s?.today ?? 0,
				spendLastHour: s?.lastHour ?? 0,
				lastActivity: a?.lastActivity ?? null,
				snippet:
					typeof a?.snippet === "string" ? a.snippet.slice(0, 120) : null,
			};
		}
		res.json(stats);
	});

	// Get one mission.
	router.get("/:id", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		// Refresh live machine state from Fly.
		if (mission.machineId && mission.status !== "destroyed") {
			try {
				const liveState = await getMachineState(mission.machineId);
				const mapped = liveStateToStatus(liveState);
				if (mapped !== mission.status) {
					await col.updateOne(
						{ missionId: req.params.id },
						{ $set: { status: mapped, updatedAt: new Date() } },
					);
					mission.status = mapped;
				}
			} catch {
				// Fly API unavailable — return cached status.
			}
		}
		res.json(mission);
	});

	// All mailbox messages the operator participates in (sender or recipient), for
	// the cockpit Conversations panel. The client folds these into threads by
	// participant set. read/unread reuses the mailbox `readBy` array.
	router.get("/:id/conversations", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		const msgs = await db
			.collection("mailbox")
			.find({
				missionId: req.params.id,
				$or: [{ from: "user" }, { to: "user" }],
			})
			.sort({ timestamp: 1 })
			.limit(500)
			.toArray();
		res.json(
			msgs.map((m) => ({
				id: m.id,
				from: m.from,
				to: Array.isArray(m.to) ? m.to : [m.to],
				subject: m.subject,
				body: m.body,
				timestamp: m.timestamp,
				read:
					m.from === "user" ||
					(Array.isArray(m.readBy) && m.readBy.includes("user")),
			})),
		);
	});

	// The mission's agent roster, for the compose recipient chips.
	router.get("/:id/agents", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		// Prefer the live daemon's actual roster over the stored structured
		// config: the mission copilot (ADR-0016) is injected in-memory only at
		// daemon startup, never written back to `agents`, so a static read
		// alone would never include it — the cockpit would never be able to
		// show or address it, no matter what its id is.
		if (mission.status === "running" && mission.privateIp) {
			try {
				const host = mission.privateIp.includes(":")
					? `[${mission.privateIp}]`
					: mission.privateIp;
				// 10s, matching every other control-plane→execution-plane call
				// (copilot-tools.ts's monitorFetch/monitorPost) — 5s was too
				// tight for this cross-app WireGuard hop and caused silent,
				// undiagnosable fallback to the stale static roster.
				const liveRes = await fetch(`http://${host}:4000/team`, {
					signal: AbortSignal.timeout(10_000),
				});
				if (liveRes.ok) {
					const live = (await liveRes.json()) as Array<{
						id: string;
						name: string;
					}>;
					res.json(live.map((a) => ({ id: a.id, name: a.name ?? a.id })));
					return;
				}
				console.error(
					`[missions] live /team fetch returned ${liveRes.status} { missionId: "${req.params.id}", privateIp: "${mission.privateIp}" } — falling back to stored config`,
				);
			} catch (e) {
				console.error(
					`[missions] live /team fetch failed { missionId: "${req.params.id}", privateIp: "${mission.privateIp}", error: "${(e as Error).message}" } — falling back to stored config`,
				);
			}
		}
		res.json(
			(mission.agents ?? []).map((a) => ({ id: a.id, name: a.name ?? a.id })),
		);
	});

	// Mark operator messages as read (body: { ids: string[] }).
	router.post("/:id/messages/read", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		const ids = (req.body?.ids as string[] | undefined) ?? [];
		if (ids.length > 0) {
			await db
				.collection("mailbox")
				.updateMany(
					{ missionId: req.params.id, to: "user", id: { $in: ids } },
					{ $addToSet: { readBy: "user" } },
				);
		}
		res.json({ ok: true });
	});

	// Send an operator message to one or more agents (wakes them via the mailbox
	// Change Stream, same as cli-post). Body: { to: string | string[], body, subject? }.
	router.post("/:id/messages/send", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		const rawTo = req.body?.to;
		const to = (Array.isArray(rawTo) ? rawTo : [rawTo]).filter(
			(t): t is string => typeof t === "string" && t.length > 0,
		);
		const body = req.body?.body as string | undefined;
		if (to.length === 0 || !body) {
			res
				.status(400)
				.json({ error: "to (string | string[]) and body are required" });
			return;
		}
		await db.collection("mailbox").insertOne({
			id: randomUUID(),
			missionId: req.params.id,
			from: "user",
			to,
			subject:
				(req.body?.subject as string | undefined) ?? "Message from operator",
			body,
			timestamp: new Date(),
			readBy: [],
		});
		res.json({ ok: true });
	});

	// ── Transcript + LLM-log explorer (the cockpit Transcripts tab) ────────────

	// Turn timeline for one agent (from agentTurnStats).
	router.get("/:id/turns", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		const agent = req.query.agent as string | undefined;
		if (!agent) {
			res.status(400).json({ error: "agent query param required" });
			return;
		}
		const turns = await db
			.collection("agentTurnStats")
			.find({ missionId: req.params.id, agentId: agent })
			.sort({ turnNumber: 1 })
			.toArray();
		res.json(
			turns.map((t) => ({
				turnNumber: t.turnNumber,
				startedAt: t.startedAt,
				completedAt: t.completedAt ?? null,
				status: t.status,
				llmCallCount: t.llmCallCount ?? 0,
				costUsd: t.costUsd ?? 0,
				peakContextTokens: t.peakContextTokens ?? 0,
				toolCalls: t.toolCalls ?? {},
				toolErrors: t.toolErrors ?? {},
			})),
		);
	});

	// Detailed transcript for one agent+turn (conversationMessages, including
	// Research sub-loop messages tagged with parentToolUseId).
	router.get("/:id/transcript", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		const agent = req.query.agent as string | undefined;
		const turn = Number(req.query.turn);
		if (!agent || Number.isNaN(turn)) {
			res.status(400).json({ error: "agent and turn query params required" });
			return;
		}
		const docs = await db
			.collection("conversationMessages")
			.find({ missionId: req.params.id, agentId: agent, turnNumber: turn })
			.sort({ callSeq: 1, _id: 1 })
			.toArray();
		res.json(
			docs.map((d) => ({
				callSeq: d.callSeq ?? 0,
				parentToolUseId: d.parentToolUseId ?? null,
				message: d.message,
			})),
		);
	});

	// LLM calls for one agent+turn — summaries (the drill-down list).
	router.get("/:id/llm-calls", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		const agent = req.query.agent as string | undefined;
		const turn = Number(req.query.turn);
		if (!agent || Number.isNaN(turn)) {
			res.status(400).json({ error: "agent and turn query params required" });
			return;
		}
		const calls = await db
			.collection("llmCallLog")
			.find({ missionId: req.params.id, agentId: agent, turnNumber: turn })
			.sort({ savedAt: 1 })
			.toArray();
		res.json(
			calls.map((c, i) => ({
				index: i,
				savedAt: c.savedAt,
				model: c.model,
				isReflection: c.isReflection ?? false,
				costEstimated: c.costEstimated ?? false,
				stopReason: c.output?.response?.stopReason ?? null,
				usage: c.usage ?? null,
				cost: c.cost ?? null,
				toolNames: c.input?.toolNames ?? [],
				messageCount: Array.isArray(c.input?.messages)
					? c.input.messages.length
					: 0,
				hasBody: Boolean(c.output),
			})),
		);
	});

	// One full LLM call (the drill-down detail: exact input + output). `output`
	// is absent after the 7-day retention window (usage/cost still present).
	router.get("/:id/llm-call", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		const agent = req.query.agent as string | undefined;
		const turn = Number(req.query.turn);
		const i = Number(req.query.i);
		if (!agent || Number.isNaN(turn) || Number.isNaN(i)) {
			res
				.status(400)
				.json({ error: "agent, turn and i query params required" });
			return;
		}
		const c = (
			await db
				.collection("llmCallLog")
				.find({ missionId: req.params.id, agentId: agent, turnNumber: turn })
				.sort({ savedAt: 1 })
				.skip(i)
				.limit(1)
				.toArray()
		)[0];
		if (!c) {
			res.status(404).json({ error: "call not found" });
			return;
		}
		res.json({
			index: i,
			savedAt: c.savedAt,
			model: c.model,
			isReflection: c.isReflection ?? false,
			costEstimated: c.costEstimated ?? false,
			usage: c.usage ?? null,
			cost: c.cost ?? null,
			input: c.input ?? null,
			output: c.output ?? null,
		});
	});

	// Get full config for editing — structured config + live mental maps per agent.
	router.get("/:id/config", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		if (!mission.mission || !mission.agents) {
			res.status(404).json({ error: "No config stored for this mission" });
			return;
		}

		const mentalMaps: Record<string, string> = {};
		const convCol = db.collection("conversationMessages");
		for (const agentId of mission.agents.map((a) => a.id)) {
			const doc = await convCol.findOne(
				{
					agentId,
					missionId: mission.missionId,
					mentalMapHtml: { $exists: true },
				},
				{ sort: { turnNumber: -1, seqInTurn: -1 } },
			);
			if (doc?.mentalMapHtml) {
				mentalMaps[agentId] = doc.mentalMapHtml as string;
			}
		}

		res.json({
			mission: mission.mission,
			agents: mission.agents,
			missionCopilotLimits: mission.missionCopilotLimits,
			teamFiles: mission.teamFiles ?? [],
			mentalMaps,
		});
	});

	// Update config (structured + mental maps). Mission must be suspended.
	router.put("/:id/config", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		if (mission.status !== "suspended") {
			res
				.status(409)
				.json({ error: "Mission must be suspended before editing config" });
			return;
		}

		const {
			mission: nextMission,
			agents,
			missionCopilotLimits,
			teamFiles,
			mentalMaps,
		} = req.body as {
			mission?: TeamConfig["mission"];
			agents?: AgentConfig[];
			missionCopilotLimits?: Limits;
			teamFiles?: Array<{ path: string; content: string }>;
			mentalMaps?: Record<string, string>;
		};
		if (!nextMission || !agents) {
			res.status(400).json({ error: "mission and agents are required" });
			return;
		}
		let validated: TeamConfig;
		try {
			validated = parseTeamConfig({
				mission: { ...nextMission, id: req.params.id },
				agents,
				missionCopilotLimits,
			});
		} catch (e) {
			res
				.status(400)
				.json({ error: `Invalid team config: ${(e as Error).message}` });
			return;
		}

		await createMongoMissionConfigWriter(db).write(
			req.params.id,
			{
				mission: validated.mission,
				agents: validated.agents,
				missionCopilotLimits: validated.missionCopilotLimits,
			},
			"user",
		);
		await col.updateOne(
			{ missionId: req.params.id },
			{ $set: { teamFiles: teamFiles ?? [] } },
		);

		// Update live mental maps in conversationMessages if provided.
		if (mentalMaps && Object.keys(mentalMaps).length > 0) {
			const convCol = db.collection("conversationMessages");
			for (const [agentId, html] of Object.entries(mentalMaps)) {
				const latest = await convCol.findOne(
					{
						agentId,
						missionId: req.params.id,
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
				// If no record found: mission never ran; initialMentalMap in the YAML is sufficient.
			}
		}

		res.json({ ok: true });
	});

	// ── Limits (cockpit Limits panel) ─────────────────────────────────────────

	router.get("/:id/limits", async (req, res) => {
		const result = await readLimits(col, db, req.params.id, userFilter(req));
		res.status(result.status).json(result.body);
	});

	router.patch("/:id/limits/mission", async (req, res) => {
		const maxCostUsd = req.body?.maxCostUsd;
		if (typeof maxCostUsd !== "number") {
			res.status(400).json({ error: "maxCostUsd (number) is required" });
			return;
		}
		const result = await writeMissionCap(
			col,
			db,
			req.params.id,
			userFilter(req),
			maxCostUsd,
		);
		res.status(result.status).json(result.body);
	});

	router.patch("/:id/limits/agent/:agentId", async (req, res) => {
		const limits = req.body?.limits;
		if (
			limits !== null &&
			(typeof limits !== "object" || Array.isArray(limits))
		) {
			res.status(400).json({ error: "limits (object or null) is required" });
			return;
		}
		const result = await writeAgentLimits(
			col,
			db,
			req.params.id,
			userFilter(req),
			req.params.agentId,
			limits,
		);
		res.status(result.status).json(result.body);
	});

	// Provision a new mission.
	router.post("/", async (req, res) => {
		const {
			missionId,
			name,
			teamConfig,
			mission: inlineMission,
			agents: inlineAgents,
			missionCopilotLimits: inlineMissionCopilotLimits,
			teamFiles: inlineFiles,
		} = req.body as {
			missionId?: string;
			name?: string;
			teamConfig?: string;
			mission?: TeamConfig["mission"];
			agents?: AgentConfig[];
			missionCopilotLimits?: Limits;
			teamFiles?: Array<{ path: string; content: string }>;
		};
		if (!missionId || !name || !teamConfig) {
			res
				.status(400)
				.json({ error: "missionId, name, and teamConfig are required" });
			return;
		}

		// Resolve structured config BEFORE inserting the mission doc so a bad
		// payload or an unknown template name never leaves a stuck
		// "provisioning" document — an explicit error here, not a silent
		// fallback to a generic default (ADR-0021: a deliberate correctness
		// fix over the previous behavior).
		let resolvedConfig: TeamConfig;
		let resolvedFiles: Array<{ path: string; content: string }>;

		if (inlineMission && inlineAgents) {
			try {
				resolvedConfig = parseTeamConfig({
					mission: { ...inlineMission, id: missionId },
					agents: inlineAgents,
					missionCopilotLimits: inlineMissionCopilotLimits,
				});
			} catch (e) {
				res
					.status(400)
					.json({ error: `Invalid team config: ${(e as Error).message}` });
				return;
			}
			resolvedFiles = inlineFiles ?? [];
		} else {
			const template = getTemplate(teamConfig);
			if (!template) {
				res.status(404).json({ error: `Unknown template "${teamConfig}"` });
				return;
			}
			resolvedConfig = {
				...template.config,
				mission: { ...template.config.mission, id: missionId },
			};
			resolvedFiles = template.teamFiles;
		}

		const existing = await col.findOne({ missionId });
		if (existing) {
			res.status(409).json({ error: "Mission already exists" });
			return;
		}

		// Resolve teamFiles BEFORE inserting the mission doc so the daemon can
		// fetch them from MongoDB at startup instead of reading a large
		// TEAM_FILES_PAYLOAD env var (which would exceed Fly's machine config
		// limit for team configs with many skill files).
		const doc: MissionDoc = {
			missionId,
			userId: req.userId,
			name,
			teamConfig,
			mission: resolvedConfig.mission,
			agents: resolvedConfig.agents,
			missionCopilotLimits: resolvedConfig.missionCopilotLimits,
			teamFiles: resolvedFiles,
			status: "provisioning",
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		await col.insertOne(doc);

		try {
			// Cloud: omit teamFiles from the machine env — daemon fetches from MongoDB.
			// Local: write to disk since the developer's daemon reads from the local path.
			const handle = isLocalExecution()
				? provisionLocal(missionId, { teamFiles: resolvedFiles })
				: await provisionMission(missionId, {});
			await col.updateOne(
				{ missionId },
				{
					$set: {
						machineId: handle.machineId,
						privateIp: handle.privateIp,
						volumeId: handle.volumeId,
						status: "running",
						updatedAt: new Date(),
					},
				},
			);
			res.status(201).json({ ...doc, ...handle, status: "running" });
		} catch (e) {
			const errorMessage = (e as Error).message;
			console.error(
				`[missions] provision failed { missionId: "${missionId}", error: "${errorMessage}" }`,
			);
			await col.updateOne(
				{ missionId },
				{ $set: { status: "error", errorMessage, updatedAt: new Date() } },
			);
			res.status(500).json({ error: errorMessage });
		}
	});

	// Suspend.
	router.post("/:id/suspend", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission?.machineId) {
			res.status(404).json({ error: "Not found or no machine" });
			return;
		}
		try {
			if (!mission.machineId.startsWith("local-")) {
				await suspendMission(mission.machineId);
			}
			await col.updateOne(
				{ missionId: req.params.id },
				{ $set: { status: "suspended", updatedAt: new Date() } },
			);
			res.json({ status: "suspended" });
		} catch (e) {
			console.error(
				`[missions] suspend failed { missionId: "${req.params.id}", error: "${(e as Error).message}" }`,
			);
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// Resume — the daemon reads structured config directly from `missions` at boot (ADR-0021).
	router.post("/:id/resume", async (req, res) => {
		const missionId = req.params.id;
		const mission = await col.findOne({
			missionId,
			...userFilter(req),
		});
		if (!mission?.machineId) {
			res.status(404).json({ error: "Not found or no machine" });
			return;
		}
		// Idempotency guard: without this, a duplicate/retried resume call (e.g.
		// a slow first request the operator gives up on and retries, or a
		// double-click) races with itself — the second call reads the mission
		// doc before the first call's $set lands, deletes the machine the first
		// call just created, and re-provisions again. Only a mission that isn't
		// already running or mid-provision can be (re-)resumed.
		if (mission.status === "running" || mission.status === "provisioning") {
			res.status(409).json({
				error: `Mission is already ${mission.status} — resume not needed`,
			});
			return;
		}
		try {
			if (mission.machineId.startsWith("local-")) {
				// Nothing to re-write — the developer's restarted daemon reads
				// structured config directly from `missions` at boot (ADR-0021),
				// same as the Fly path below.
			} else {
				// Resume on Fly: delete the stopped machine and provision a fresh one
				// against the preserved workspace volume. This guarantees the new machine
				// boots with the current config from MongoDB — the Fly PATCH API for
				// env-var updates on stopped machines is unreliable.
				if (!mission.volumeId) {
					throw new Error(
						"No volume ID stored for this mission — cannot resume",
					);
				}
				// Best-effort delete of the old machine. If it's already gone (deleted
				// outside MAGI), skip and proceed to provision.
				try {
					await deleteMachine(mission.machineId);
					console.log(
						`[missions] deleted old machine ${mission.machineId} before re-provision`,
					);
				} catch (e) {
					console.warn(
						`[missions] could not delete machine ${mission.machineId}: ${(e as Error).message} — proceeding to provision anyway`,
					);
				}
				const handle = await provisionMission(missionId, {
					existingVolumeId: mission.volumeId,
					// teamFiles omitted: daemon fetches from missions collection at startup
				});
				await col.updateOne(
					{ missionId },
					{
						$set: {
							machineId: handle.machineId,
							privateIp: handle.privateIp,
							status: "running",
							updatedAt: new Date(),
						},
						$unset: { errorMessage: "" },
					},
				);
				res.json({ status: "running" });
				return;
			}
			await col.updateOne(
				{ missionId },
				{
					$set: { status: "running", updatedAt: new Date() },
					$unset: { errorMessage: "" },
				},
			);
			res.json({ status: "running" });
		} catch (e) {
			const errorMessage = (e as Error).message;
			console.error(
				`[missions] resume failed { missionId: "${missionId}", error: "${errorMessage}" }`,
			);
			// Surface the failure in Mongo, not just the HTTP response — without
			// this, a failed resume left the mission looking like an ordinary,
			// resumable "suspended" mission while actually pointing at a machine
			// that may already be deleted, with no visible explanation anywhere.
			await col.updateOne(
				{ missionId },
				{ $set: { status: "error", errorMessage, updatedAt: new Date() } },
			);
			res.status(500).json({ error: errorMessage });
		}
	});

	// Destroy (irreversible).
	router.delete("/:id", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		try {
			if (mission.machineId?.startsWith("local-")) {
				destroyLocal(req.params.id);
			} else if (mission.machineId && mission.volumeId) {
				await destroyMission(mission.machineId, mission.volumeId);
			}
			await col.updateOne(
				{ missionId: req.params.id },
				{ $set: { status: "destroyed", updatedAt: new Date() } },
			);
			res.json({ status: "destroyed" });
		} catch (e) {
			console.error(
				`[missions] destroy failed { missionId: "${req.params.id}", error: "${(e as Error).message}" }`,
			);
			res.status(500).json({ error: (e as Error).message });
		}
	});

	return router;
}

function liveStateToStatus(flyState: string): MissionDoc["status"] {
	switch (flyState) {
		case "started":
		case "starting":
			return "running";
		case "stopped":
		case "stopping":
			return "suspended";
		case "destroyed":
		case "destroying":
			return "destroyed";
		default:
			return "error";
	}
}
