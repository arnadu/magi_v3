import { api, mp, request } from "./http";

// Control-plane-native routes (/api/missions/:id/...), not monitor-proxied —
// these read/write teamConfigYaml directly via MongoDB, so they work
// regardless of whether the mission is currently running.

export interface AgentLimits {
	maxLlmCallsPerTurn?: number;
	maxCostPerTurnUsd?: number;
	maxLifetimeCostUsd?: number;
	warnLlmCallsPerTurn?: number;
	warnPeakContextTokens?: number;
	warnToolErrorsPerTurn?: number;
	warnConsecutiveZeroOutputTurns?: number;
}

export interface AgentLimitsRow {
	agentId: string;
	limits: AgentLimits;
	/** Configured value, else the built-in soft default — always populated. */
	effectiveSoft: Required<
		Pick<
			AgentLimits,
			| "warnLlmCallsPerTurn"
			| "warnPeakContextTokens"
			| "warnToolErrorsPerTurn"
			| "warnConsecutiveZeroOutputTurns"
		>
	>;
	live: {
		lifetimeCostUsd: number | null;
		lifetimeLlmCallCount: number | null;
		consecutiveZeroOutputTurns: number | null;
		/** Turn-scoped hard/soft limits can only be compared against the most
		 * recently completed turn — no route exposes a genuinely in-progress one. */
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
		/** The most the cap may be set to, by anyone including the mission
		 * copilot; only the Limits panel writes it. Null = the platform ceiling. */
		maxCostCeilingUsd: number | null;
		/** PLATFORM_MAX_COST_CEILING_USD — the most a ceiling may be set to... */
		platformCeilingUsd: number;
		/** ...unless this user is a platform admin. */
		canExceedPlatformCeiling: boolean;
	};
	agents: AgentLimitsRow[];
	/** False when suspended/provisioning/etc — live numbers are unavailable then. */
	missionRunning: boolean;
	/** Temporary machine upgrades (ADR-0031 Decision 7). */
	upgrades: {
		usedHours: number;
		capHours: number;
		/** ISO timestamp of the operator's last reset, or null if never reset. */
		resetAt: string | null;
		active: {
			cpuKind: string;
			cpus: number;
			memoryMb: number;
			expiresAt: string;
			requestedByAgentId?: string;
		} | null;
	};
}

// ── Runtime tab (ADR-0031) — machine time by config, not $ spend ──────────

export interface MachineRuntimeRow {
	shape: { cpuKind: string; cpus: number; memoryMb: number };
	upgraded: boolean;
	ms: number;
	/** Display-only estimate from the static price table — never enforcement. */
	estimatedCostUsd: number;
}

export interface MachineRuntimeData {
	byHorizon: Record<"today" | "7d" | "30d" | "lifetime", MachineRuntimeRow[]>;
}

export function fetchMachineRuntime(
	missionId: string,
): Promise<MachineRuntimeData> {
	return api<MachineRuntimeData>(
		`/api/missions/${mp(missionId)}/machine-runtime`,
	);
}

export function fetchLimits(missionId: string): Promise<LimitsData> {
	return api<LimitsData>(`/api/missions/${mp(missionId)}/limits`);
}

/** Issue #31/ADR-0031 — resets the cumulative upgraded-machine-runtime cap to
 * 0. No mission tool can ever call this route; only the cockpit Limits panel
 * can, matching the same structural-separation pattern as
 * saveMissionCostCeiling (see missions.ts's writeUpgradedRuntimeReset). */
export async function resetUpgradedRuntime(
	missionId: string,
): Promise<{ resetAt: string }> {
	const res = await request(
		`/api/missions/${mp(missionId)}/limits/upgrade-reset`,
		{ method: "PATCH" },
	);
	return (await res.json()) as { resetAt: string };
}

/** Returns whether the mission's own live cap was also updated immediately
 * (only possible while running) — the persisted write always succeeds
 * regardless, and is what survives a future resume either way. */
export async function saveMissionCap(
	missionId: string,
	maxCostUsd: number,
): Promise<{ liveUpdateApplied: boolean }> {
	const res = await request(`/api/missions/${mp(missionId)}/limits/mission`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ maxCostUsd }),
	});
	return (await res.json()) as { liveUpdateApplied: boolean };
}

/** Issue #49 / F-025 — sets the operator-only spend-cap ceiling. No mission
 * tool (SetMissionSpendCap, SaveMissionConfig) can ever call this route or
 * raise this value; only the cockpit Limits panel can, matching the fact
 * that maxCostCeilingUsd is a structurally separate field from the writer
 * those tools share (see missions.ts's writeMissionCostCeiling). */
export async function saveMissionCostCeiling(
	missionId: string,
	ceilingUsd: number,
): Promise<{ maxCostCeilingUsd: number }> {
	const res = await request(`/api/missions/${mp(missionId)}/limits/ceiling`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ceilingUsd }),
	});
	return (await res.json()) as { maxCostCeilingUsd: number };
}

/** `limits: null` clears every configured limit for that agent. Takes effect
 * the next time the mission is resumed, not immediately. */
export async function saveAgentLimits(
	missionId: string,
	agentId: string,
	limits: AgentLimits | null,
): Promise<void> {
	await request(`/api/missions/${mp(missionId)}/limits/agent/${mp(agentId)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ limits }),
	});
}

// ── Standalone copilot chat — cross-mission, control-plane-native ──────────
