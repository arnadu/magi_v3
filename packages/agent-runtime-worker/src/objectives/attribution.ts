/**
 * Cost attribution (Sprint 26a, deliverables B2 + B2b).
 *
 * At each turn end the daemon attributes the agent's spend. The amount is
 * derived (carry-over needs no stored state): `lifetimeCostUsd − alreadyAttributed`.
 * The split target is chosen by priority:
 *   1. an explicit `allocate` intent this turn (the timesheet fallback) — split
 *      across its key (task ids, objective ids, or "overhead");
 *   2. else the tasks the agent updated this turn — split by `--effort`;
 *   3. else, if the balance is stale and the agent owns objectives, its own
 *      objective(s) (supervisor overhead lands where it belongs);
 *   4. else carry over to a future turn.
 *
 * Precision is honest: turn-granular, effort-weighted — trustworthy at the
 * objective level, approximate per task.
 */

import {
	appendEvent,
	loadAllocEvents,
	loadCostEvents,
	loadGoals,
	loadTaskEvents,
} from "./store.js";
import type { AllocEvent, CostEvent, GoalsFile, TaskEvent } from "./types.js";

/** A carry-over balance this many turns stale triggers the fallbacks. */
export const STALE_TURNS = 3;

/**
 * Tasks the agent updated within [startIso, endIso], mapped to a weight. The
 * weight is the largest `effort` seen on that task's updates this turn (a bare
 * update with no effort counts as 1).
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

/** Turns since this agent last had cost attributed (1-based; never → currentTurn+1). */
export function turnsSinceLastAttribution(
	costEvents: CostEvent[],
	agentId: string,
	currentTurn: number,
): number {
	let last = -1;
	for (const ev of costEvents) {
		if (ev.agent === agentId) last = Math.max(last, ev.turn);
	}
	return currentTurn - last;
}

/** Latest allocate intent by this agent within the turn window, as a weight map. */
function latestAllocInWindow(
	allocEvents: AllocEvent[],
	agentId: string,
	startIso: string,
	endIso: string,
): Map<string, number> | null {
	let latest: AllocEvent | null = null;
	for (const ev of allocEvents) {
		if (ev.by !== agentId) continue;
		if (ev.at < startIso || ev.at > endIso) continue;
		if (!latest || ev.at >= latest.at) latest = ev;
	}
	if (!latest) return null;
	return new Map(Object.entries(latest.key));
}

/** Objective ids this agent owns (supervisor role). */
function ownedObjectiveIds(goals: GoalsFile, agentId: string): string[] {
	return goals.objectives.filter((o) => o.owner === agentId).map((o) => o.id);
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
 * Attribute the agent's unattributed spend. Returns the appended cost event, or
 * `null` when nothing was attributed (no task store, no spend outstanding, or
 * the cost carries over).
 */
export async function attributeTurnCost(
	sharedDir: string,
	p: AttributeParams,
): Promise<CostEvent | null> {
	const [taskEvents, costEvents, allocEvents, goals] = await Promise.all([
		loadTaskEvents(sharedDir),
		loadCostEvents(sharedDir),
		loadAllocEvents(sharedDir),
		loadGoals(sharedDir),
	]);
	if (taskEvents.length === 0 && goals.objectives.length === 0) return null;

	const unattributed =
		p.lifetimeCostUsd - alreadyAttributed(costEvents, p.agentId);
	if (unattributed <= 1e-6) return null;

	const startIso = p.windowStart.toISOString();
	const endIso = p.windowEnd.toISOString();

	// Priority 1: an explicit allocate intent this turn.
	let weights = latestAllocInWindow(allocEvents, p.agentId, startIso, endIso);

	// Priority 2: tasks the agent updated this turn.
	if (!weights) {
		const taskWeights = tasksUpdatedInWindow(
			taskEvents,
			p.agentId,
			startIso,
			endIso,
		);
		if (taskWeights.size > 0) weights = taskWeights;
	}

	// Priority 3: a stale balance from an objective owner → its own objective(s).
	if (!weights) {
		const stale =
			turnsSinceLastAttribution(costEvents, p.agentId, p.turnNumber) >=
			STALE_TURNS;
		const owned = ownedObjectiveIds(goals, p.agentId);
		if (stale && owned.length > 0) {
			weights = new Map(owned.map((id) => [id, 1]));
		}
	}

	// Priority 4: carry over.
	if (!weights) return null;

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
