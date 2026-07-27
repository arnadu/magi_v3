/**
 * Objectives repository — MongoDB-backed (ADR-0019).
 *
 * Replaces the file-based store (`sharedDir/objectives/*` — see `store.ts`'s
 * header for the shapes this preserves). Two collections:
 *   - `objectivesGoals`  — one doc per mission, the authored objective tree +
 *     KPI definitions (`goals.json`'s equivalent). Overwritten, not merged, on
 *     write — same contract the old `saveGoals` had. Its existence for a
 *     missionId also doubles as the "already migrated" marker consumed by
 *     `migrate-legacy-store.ts`.
 *   - `objectivesEvents` — append-only, one doc per event
 *     (`{missionId, kind, ...event}`), the direct Mongo equivalent of
 *     `tasks.jsonl`/`kpis.jsonl`/`cost.jsonl`/`alloc.jsonl` combined, and also
 *     the audit trail that replaces git-log-on-goals.json (ADR-0019's
 *     "Costs" section named this loss; this collection is that replacement).
 *
 * `readTree` folds through the same pure `foldStore` in `store.ts` — nothing
 * about the fold logic changed, only where the events come from.
 */

import type { Db } from "mongodb";
import type { FoldOptions } from "./store.js";
import { foldStore } from "./store.js";
import {
	type AllocEvent,
	type CostEvent,
	type FoldedTree,
	type GoalsFile,
	GoalsFileSchema,
	type KpiEvent,
	type TaskEvent,
} from "./types.js";

export type ObjectivesReadOptions = FoldOptions & {
	autoStats?: Record<string, number>;
};

export interface ObjectivesRepository {
	/** Folded current-state tree, reading all events + goals fresh from Mongo. */
	readTree(
		missionId: string,
		opts?: ObjectivesReadOptions,
	): Promise<FoldedTree>;
	/** The authored objective tree + KPI definitions, or an empty tree if none stored. */
	readGoals(missionId: string): Promise<GoalsFile>;
	/** Overwrite (not merge) the objective tree for a mission. */
	saveGoals(
		missionId: string,
		goals: GoalsFile,
		updatedBy: string,
	): Promise<void>;
	appendTaskEvent(missionId: string, event: TaskEvent): Promise<void>;
	appendKpiEvent(missionId: string, event: KpiEvent): Promise<void>;
	appendCostEvent(missionId: string, event: CostEvent): Promise<void>;
	appendAllocEvent(missionId: string, event: AllocEvent): Promise<void>;
	readTaskEvents(missionId: string): Promise<TaskEvent[]>;
	readCostEvents(missionId: string): Promise<CostEvent[]>;
	readAllocEvents(missionId: string): Promise<AllocEvent[]>;
	/** True once a goals doc has been written for this mission (seeded or migrated). */
	hasGoalsDoc(missionId: string): Promise<boolean>;
}

interface GoalsDoc {
	missionId: string;
	objectives: GoalsFile["objectives"];
	updatedAt: Date;
	updatedBy: string;
}

type EventDoc<K extends string, E> = { missionId: string; kind: K } & E;

export function createMongoObjectivesRepository(db: Db): ObjectivesRepository {
	const goalsCol = db.collection<GoalsDoc>("objectivesGoals");
	const eventsCol = db.collection<
		| EventDoc<"task", TaskEvent>
		| EventDoc<"kpi", KpiEvent>
		| EventDoc<"cost", CostEvent>
		| EventDoc<"alloc", AllocEvent>
	>("objectivesEvents");

	async function readEvents<K extends string, E>(
		missionId: string,
		kind: K,
	): Promise<E[]> {
		const docs = await eventsCol
			.find(
				{ missionId, kind: kind as never },
				{ projection: { _id: 0, missionId: 0, kind: 0 } },
			)
			.toArray();
		return docs as unknown as E[];
	}

	async function appendEvent<K extends string, E extends object>(
		missionId: string,
		kind: K,
		event: E,
	): Promise<void> {
		await eventsCol.insertOne({
			missionId,
			kind,
			...event,
		} as never);
	}

	async function readGoalsImpl(missionId: string): Promise<GoalsFile> {
		const doc = await goalsCol.findOne(
			{ missionId },
			{ projection: { objectives: 1 } },
		);
		if (!doc) return { objectives: [] };
		try {
			return GoalsFileSchema.parse({ objectives: doc.objectives });
		} catch (e) {
			console.warn(
				`[objectives] ignoring invalid stored goals for mission ${missionId}: ${(e as Error).message}`,
			);
			return { objectives: [] };
		}
	}

	return {
		async readTree(missionId, opts = {}) {
			const goals = await readGoalsImpl(missionId);
			const [taskEvents, kpiEvents, costEvents] = await Promise.all([
				readEvents<"task", TaskEvent>(missionId, "task"),
				readEvents<"kpi", KpiEvent>(missionId, "kpi"),
				readEvents<"cost", CostEvent>(missionId, "cost"),
			]);
			return foldStore(
				{
					goals,
					taskEvents,
					kpiEvents,
					costEvents,
					autoStats: opts.autoStats,
				},
				opts,
			);
		},

		readGoals: readGoalsImpl,

		async saveGoals(missionId, goals, updatedBy) {
			const validated = GoalsFileSchema.parse(goals);
			await goalsCol.updateOne(
				{ missionId },
				{
					$set: {
						objectives: validated.objectives,
						updatedAt: new Date(),
						updatedBy,
					},
				},
				{ upsert: true },
			);
		},

		async appendTaskEvent(missionId, event) {
			await appendEvent(missionId, "task", event);
		},
		async appendKpiEvent(missionId, event) {
			await appendEvent(missionId, "kpi", event);
		},
		async appendCostEvent(missionId, event) {
			await appendEvent(missionId, "cost", event);
		},
		async appendAllocEvent(missionId, event) {
			await appendEvent(missionId, "alloc", event);
		},

		async readTaskEvents(missionId) {
			return readEvents<"task", TaskEvent>(missionId, "task");
		},
		async readCostEvents(missionId) {
			return readEvents<"cost", CostEvent>(missionId, "cost");
		},
		async readAllocEvents(missionId) {
			return readEvents<"alloc", AllocEvent>(missionId, "alloc");
		},

		async hasGoalsDoc(missionId) {
			const doc = await goalsCol.findOne(
				{ missionId },
				{ projection: { _id: 1 } },
			);
			return doc !== null;
		},
	};
}
