/**
 * Mission spend limits — the cap, its ceiling and per-agent limits — as
 * written by the cockpit Limits panel and the copilot. Every cap write,
 * whoever makes it, is bound by the mission's ceiling (F-025) and every
 * ceiling by the platform's unless an admin raises it (ADR-0034).
 */

/**
 * Mission CRUD + lifecycle routes.
 *
 * POST   /api/missions              — provision a new mission
 * POST   /api/missions/draft        — create a draft mission (no machine, no validation gate)
 * GET    /api/missions              — list all missions
 * GET    /api/missions/:id          — get one mission
 * GET    /api/missions/:id/config   — get structured config + live mental maps
 * PUT    /api/missions/:id/config   — update structured config + mental maps (suspended only)
 * PUT    /api/missions/:id/draft    — update a draft's config (draft only, permissive)
 * POST   /api/missions/:id/launch   — validate + provision a draft, flips it to running
 * POST   /api/missions/:id/suspend  — stop execution machine
 * POST   /api/missions/:id/resume   — start execution machine
 * DELETE /api/missions/:id          — destroy machine + volume (irreversible)
 */

import {
	type Limits,
	LimitsSchema,
	parseTeamConfig,
	type TeamConfig,
} from "@magi/agent-config";
import {
	createMongoMissionConfigWriter,
	DEFAULT_SOFT_LIMITS,
} from "@magi/agent-runtime-worker";
import type { Collection, Db } from "mongodb";
import { postMailbox } from "./mailbox-writer.js";
import type { AgentLimitsRow, MissionDoc } from "./missions.js";
import { deriveMonitorToken } from "./monitor-token.js";
import { ceilingChangeRefusal, effectiveCeilingUsd } from "./spend-policy.js";

export interface RouteResult {
	status: number;
	body: unknown;
}

export function effectiveSoftOf(
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
export async function postLimitsAudit(
	db: Db,
	missionId: string,
	subject: string,
	body: string,
): Promise<void> {
	await postMailbox(db, {
		missionId,
		from: "user",
		to: ["mission-copilot"],
		subject,
		body,
	});
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

	// Issue #49 / F-025: the operator's own cap-raise is bound by the same
	// ceiling as the mission-copilot's SetMissionSpendCap/SaveMissionConfig
	// paths (mission-config.ts, mission-copilot-tools.ts) — one consistent
	// rule regardless of caller, so raising the cap above the ceiling always
	// means raising the ceiling first via writeMissionCostCeiling below.
	const ceiling = effectiveCeilingUsd(mission);
	if (maxCostUsd > ceiling) {
		return {
			status: 403,
			body: {
				error: `A cap of $${maxCostUsd.toFixed(2)} is above this mission's spend-cap ceiling of $${ceiling.toFixed(2)}. Raise the ceiling first (Limits panel, "Spend-cap ceiling"), then the cap. The ceiling is the most anyone — including the mission copilot — may set the cap to. See docs/spend-limits.md.`,
			},
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

/**
 * Issue #49 / F-025: the operator-only spend-cap ceiling. Writes directly to
 * the top-level maxCostCeilingUsd field — deliberately NOT through
 * createMongoMissionConfigWriter (the mission/agents/missionCopilotLimits
 * writer SaveMissionConfig/EditDraftConfig/PUT /:id/config also use) — so
 * this stays a structurally separate write path no execution-plane tool can
 * ever reach, regardless of what future tool gets added to that shared
 * writer's surface.
 */
export async function writeMissionCostCeiling(
	col: Collection<MissionDoc>,
	db: Db,
	missionId: string,
	filter: Partial<MissionDoc>,
	ceilingUsd: number,
	isAdmin = false,
): Promise<RouteResult> {
	if (!(ceilingUsd > 0)) {
		return { status: 400, body: { error: "ceilingUsd must be > 0" } };
	}
	// D-3: the per-mission ceiling is the operator's to set, but only below
	// the platform ceiling; a platform admin may go above it.
	const refusal = ceilingChangeRefusal(ceilingUsd, isAdmin);
	if (refusal) return { status: 403, body: { error: refusal } };
	const mission = await col.findOne({ missionId, ...filter });
	if (!mission) return { status: 404, body: { error: "Not found" } };

	await col.updateOne(
		{ missionId },
		{ $set: { maxCostCeilingUsd: ceilingUsd, updatedAt: new Date() } },
	);

	await postLimitsAudit(
		db,
		missionId,
		"Spend-cap ceiling changed",
		`Operator set this mission's spend-cap ceiling to $${ceilingUsd.toFixed(2)} via the cockpit Limits panel. The mission-wide spend cap can never be raised above this value by any mission tool.`,
	);

	return { status: 200, body: { ok: true, maxCostCeilingUsd: ceilingUsd } };
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
