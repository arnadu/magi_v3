/**
 * The control-plane copilot's spend containment (CST-3): every user's
 * copilot has a hard cap — their own, or DEFAULT_COPILOT_SPEND_CAP_USD — no
 * higher than the platform ceiling unless a platform admin sets it, checked
 * before every turn and after every LLM call inside one, and every turn has a
 * wall-clock bound. The user manages the cap in the cockpit (home → Copilot →
 * Limits, `GET/PATCH /api/copilot/limits`).
 */

import {
	createMongoAgentStatsRepository,
	StatsCollector,
} from "@magi/agent-runtime-worker";
import type { Db } from "mongodb";
import { getCopilotSpendCap } from "./users.js";

/** The copilot's own agent id, as defined in config/teams/copilot.yaml. */
export const COPILOT_AGENT_ID = "copilot";

/** Cap for a user who has not set one. "Reset to default" in the cockpit returns here. */
export const DEFAULT_COPILOT_SPEND_CAP_USD = 25;

/** The longest one copilot turn may run before it is stopped. */
export const COPILOT_MAX_TURN_MS = 20 * 60_000;

/**
 * Lifetime spend for the copilot including the turn in flight, read fresh
 * every call (same "no cache for verification-critical data" discipline as
 * the mission spend cap). missionStats alone is updated only at turn end, so
 * a check inside a turn would never see that turn's own spend.
 */
export async function readCopilotSpend(
	db: Db,
	missionId: string,
): Promise<number> {
	const snapshot = await new StatsCollector(
		createMongoAgentStatsRepository(db),
	).readMissionSnapshot(missionId);
	return snapshot
		.filter((a) => a.agentId === COPILOT_AGENT_ID)
		.reduce((sum, a) => sum + a.lifetimeCostUsd + a.turnCostUsd, 0);
}

/** The cap that binds a user's copilot, and whether it is the default. */
export async function effectiveCopilotCap(
	db: Db,
	userId: string,
): Promise<{ capUsd: number; isDefault: boolean }> {
	const stored = await getCopilotSpendCap(db, userId);
	return stored === undefined
		? { capUsd: DEFAULT_COPILOT_SPEND_CAP_USD, isDefault: true }
		: { capUsd: stored, isDefault: false };
}

/**
 * Returns an error message if the user's copilot spend cap is reached (the
 * caller should refuse or stop the turn with it), or null if it may proceed.
 */
export async function checkCopilotSpendCap(
	db: Db,
	userId: string,
): Promise<string | null> {
	const { capUsd } = await effectiveCopilotCap(db, userId);
	const spentUsd = await readCopilotSpend(db, `copilot-${userId}`);
	if (spentUsd < capUsd) return null;
	return `Copilot spend cap reached ($${spentUsd.toFixed(2)} / $${capUsd.toFixed(2)}). Raise the cap in the Copilot → Limits tab to continue.`;
}

/**
 * One turn's guard: an AbortSignal that fires on shutdown, at the wall-clock
 * bound, or when `checkAfterCall` finds the cap reached. `stopReason()` says
 * which, for the operator.
 */
export function createCopilotTurnGuard(opts: {
	db: Db;
	userId: string;
	parent: AbortSignal;
	maxTurnMs?: number;
}): {
	signal: AbortSignal;
	checkAfterCall: () => Promise<void>;
	stopReason: () => string | null;
	dispose: () => void;
} {
	const ac = new AbortController();
	let reason: string | null = null;
	const stop = (why: string) => {
		if (ac.signal.aborted) return;
		reason = why;
		ac.abort();
	};
	const onParent = () => stop("the control plane is shutting down");
	opts.parent.addEventListener("abort", onParent, { once: true });
	const maxMs = opts.maxTurnMs ?? COPILOT_MAX_TURN_MS;
	const timer = setTimeout(
		() =>
			stop(`the turn ran past its ${Math.round(maxMs / 60_000)}-minute limit`),
		maxMs,
	);
	return {
		signal: ac.signal,
		async checkAfterCall() {
			const capped = await checkCopilotSpendCap(opts.db, opts.userId).catch(
				(e: unknown) => {
					// One failed read does not stop the turn; the next call re-checks,
					// and the wall-clock bound still holds.
					console.error(
						`[copilot-spend] in-turn cap check failed { userId: "${opts.userId}", error: "${(e as Error).message}" }`,
					);
					return null;
				},
			);
			if (capped) stop(capped);
		},
		stopReason: () => reason,
		dispose() {
			clearTimeout(timer);
			opts.parent.removeEventListener("abort", onParent);
		},
	};
}
