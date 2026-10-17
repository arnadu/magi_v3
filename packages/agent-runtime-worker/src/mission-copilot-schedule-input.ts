/**
 * Input validation for the mission copilot's `CreateScheduledMessage` (MC7):
 * recipients must be agents of the mission (or the operator), the text fields
 * are bounded, `deliverAt` must parse and be plausible, and a cron must not
 * fire more often than every few minutes — each fire is a paid LLM turn.
 */

import cronParser from "cron-parser";
import type { Db } from "mongodb";
import { MISSION_COPILOT_AGENT_ID } from "./mission-copilot.js";

const { parseExpression } = cronParser;

/** A cron firing more often than this is almost always a mistake. */
export const MIN_CRON_INTERVAL_MS = 5 * 60_000;
/** A one-off further ahead than this is almost always a typo in the year. */
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 3600_000;

/** The roster comes from the mission document (ADR-0021); a mission without structured agents skips the roster check. */
export async function scheduleInputProblem(
	db: Db,
	missionId: string,
	p: { to: string[]; subject: string; body: string; label?: string },
): Promise<string | null> {
	if (p.to.length === 0 || p.to.length > 20) {
		return "to must name 1–20 recipients";
	}
	if (!p.subject?.trim() || p.subject.length > 200) {
		return "subject must be 1–200 characters";
	}
	if (!p.body?.trim() || p.body.length > 20_000) {
		return "body must be 1–20000 characters";
	}
	if (p.label !== undefined && p.label.length > 80) {
		return "label must be at most 80 characters";
	}
	const mission = await db
		.collection<{ agents?: Array<{ id: string }> }>("missions")
		.findOne({ missionId }, { projection: { agents: 1 } });
	const roster = mission?.agents?.map((a) => a.id);
	if (roster) {
		const allowed = new Set([...roster, "user", MISSION_COPILOT_AGENT_ID]);
		const unknown = p.to.filter((t) => !allowed.has(t));
		if (unknown.length) {
			return `unknown recipient(s) ${unknown.join(", ")} — this mission's agents are ${roster.join(", ")}`;
		}
	}
	return null;
}

/**
 * The first delivery time. A cron-only schedule's first delivery is the
 * expression's own next occurrence — defaulting to "now" fired a weekly
 * schedule within minutes of being created (found live).
 */
export function resolveDeliverAt(
	deliverAtRaw: string | undefined,
	cron: string | undefined,
	now: () => number = Date.now,
): { deliverAt: Date } | { error: string } {
	if (deliverAtRaw) {
		const deliverAt = new Date(deliverAtRaw);
		if (Number.isNaN(deliverAt.getTime())) {
			return { error: `deliverAt "${deliverAtRaw}" is not an ISO date-time` };
		}
		if (deliverAt.getTime() > now() + MAX_SCHEDULE_AHEAD_MS) {
			return { error: "deliverAt is more than a year ahead — check the date" };
		}
		return { deliverAt };
	}
	if (cron) {
		try {
			// UTC everywhere: the control plane re-arms in UTC (Fly machines run
			// UTC), so a cron must mean the same thing where it is first armed.
			const it = parseExpression(cron, {
				currentDate: new Date(now()),
				tz: "UTC",
			});
			const first = it.next().toDate();
			const second = it.next().toDate();
			if (second.getTime() - first.getTime() < MIN_CRON_INTERVAL_MS) {
				return {
					error: `cron "${cron}" fires more often than every ${MIN_CRON_INTERVAL_MS / 60_000} minutes — each fire is a paid LLM turn`,
				};
			}
			return { deliverAt: first };
		} catch (e) {
			return {
				error: `Invalid cron expression "${cron}": ${(e as Error).message}`,
			};
		}
	}
	return { error: "Provide either deliverAt or cron." };
}
