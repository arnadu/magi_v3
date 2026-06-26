/**
 * Cost attribution (Sprint 26a, deliverable B2).
 *
 * At each turn end the daemon attributes the agent's spend to the task(s) it
 * worked on that turn. The signal is the task-board update: a task the agent
 * updated within the turn window gets a share of the turn's cost, weighted by
 * the optional `--effort` on the update (default 1 → even split).
 *
 * Carry-over is **derived, not stored**: the amount to attribute is
 * `lifetimeCostUsd − alreadyAttributed`. So if the agent grinds for several
 * turns without touching a task, nothing is written; when it finally updates a
 * task, all the accumulated unattributed cost lands on it. This needs no extra
 * persisted state and survives a daemon restart (both inputs are durable —
 * `missionStats` and `cost.jsonl`).
 *
 * Precision is honest: turn-granular, effort-weighted by an LLM self-estimate —
 * trustworthy at the objective level, approximate per task.
 */

import { appendEvent, loadCostEvents, loadTaskEvents } from "./store.js";
import type { CostEvent, TaskEvent } from "./types.js";

/**
 * Tasks the agent updated within [startIso, endIso], mapped to a weight. The
 * weight is the largest `effort` seen on that task's updates this turn (a bare
 * update with no effort counts as 1), so repeated status edits don't inflate a
 * task's share but an explicit effort is honoured.
 */
export function tasksUpdatedInWindow(
	events: TaskEvent[],
	agentId: string,
	startIso: string,
	endIso: string,
): Map<string, number> {
	const weights = new Map<string, number>();
	for (const ev of events) {
		if (ev.by !== agentId) continue;
		if (ev.at < startIso || ev.at > endIso) continue;
		const w = ev.effort ?? 1;
		weights.set(ev.id, Math.max(weights.get(ev.id) ?? 0, w));
	}
	return weights;
}

/** Split `amount` across weighted targets, proportional to weight. */
export function splitByWeight(
	amount: number,
	weights: Map<string, number>,
): Record<string, number> {
	const total = [...weights.values()].reduce((a, b) => a + b, 0);
	const alloc: Record<string, number> = {};
	if (total <= 0) return alloc;
	for (const [id, w] of weights) {
		alloc[id] = Math.round(((amount * w) / total) * 1e6) / 1e6;
	}
	return alloc;
}

/** Sum every alloc value across the agent's prior cost events. */
function alreadyAttributed(costEvents: CostEvent[], agentId: string): number {
	let total = 0;
	for (const ev of costEvents) {
		if (ev.agent !== agentId) continue;
		for (const v of Object.values(ev.alloc)) total += v;
	}
	return total;
}

export interface AttributeParams {
	agentId: string;
	turnNumber: number;
	windowStart: Date;
	windowEnd: Date;
	/** The agent's lifetime spend so far, including the turn just ended. */
	lifetimeCostUsd: number;
}

/**
 * Attribute the agent's unattributed spend to the tasks it updated this turn.
 * Returns the appended cost event, or `null` when nothing was attributed
 * (mission not using tasks, no spend outstanding, or the cost carries over
 * because no task was updated this turn).
 */
export async function attributeTurnCost(
	sharedDir: string,
	p: AttributeParams,
): Promise<CostEvent | null> {
	const [taskEvents, costEvents] = await Promise.all([
		loadTaskEvents(sharedDir),
		loadCostEvents(sharedDir),
	]);
	if (taskEvents.length === 0) return null; // mission isn't using the task store

	const unattributed =
		p.lifetimeCostUsd - alreadyAttributed(costEvents, p.agentId);
	if (unattributed <= 1e-6) return null;

	const weights = tasksUpdatedInWindow(
		taskEvents,
		p.agentId,
		p.windowStart.toISOString(),
		p.windowEnd.toISOString(),
	);
	if (weights.size === 0) return null; // carry over to a future turn

	const alloc = splitByWeight(unattributed, weights);
	const event: CostEvent = {
		turn: p.turnNumber,
		agent: p.agentId,
		at: new Date().toISOString(),
		alloc,
	};
	await appendEvent(sharedDir, "cost", event);
	return event;
}
