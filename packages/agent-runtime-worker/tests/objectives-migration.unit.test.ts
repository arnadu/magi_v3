/**
 * migrateLegacyObjectivesStore — unit tests (ADR-0019). Uses a fake in-memory
 * ObjectivesRepository + real temp-dir fixture files (no Mongo, no network) —
 * exercises the boot-time self-migration path every mission with pre-existing
 * file-based objectives runs through the next time it resumes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyObjectivesStore } from "../src/objectives/migrate-legacy-store.js";
import type { ObjectivesRepository } from "../src/objectives/repository.js";
import { foldStore } from "../src/objectives/store.js";
import type {
	AllocEvent,
	CostEvent,
	GoalsFile,
	KpiEvent,
	TaskEvent,
} from "../src/objectives/types.js";

function createFakeObjectivesRepository(): ObjectivesRepository {
	let goals: GoalsFile = { objectives: [] };
	let hasGoals = false;
	const taskEvents: TaskEvent[] = [];
	const kpiEvents: KpiEvent[] = [];
	const costEvents: CostEvent[] = [];
	const allocEvents: AllocEvent[] = [];

	return {
		async readTree(_missionId, opts) {
			return foldStore({ goals, taskEvents, kpiEvents, costEvents }, opts);
		},
		async readGoals() {
			return goals;
		},
		async saveGoals(_missionId, g) {
			goals = g;
			hasGoals = true;
		},
		async appendTaskEvent(_missionId, e) {
			taskEvents.push(e);
		},
		async appendKpiEvent(_missionId, e) {
			kpiEvents.push(e);
		},
		async appendCostEvent(_missionId, e) {
			costEvents.push(e);
		},
		async appendAllocEvent(_missionId, e) {
			allocEvents.push(e);
		},
		async readTaskEvents() {
			return taskEvents;
		},
		async readCostEvents() {
			return costEvents;
		},
		async readAllocEvents() {
			return allocEvents;
		},
		async hasGoalsDoc() {
			return hasGoals;
		},
	};
}

const missionId = "m1";

describe("migrateLegacyObjectivesStore", () => {
	let sharedDir: string;

	beforeEach(() => {
		sharedDir = mkdtempSync(join(tmpdir(), "objectives-migration-"));
	});
	afterEach(() => {
		rmSync(sharedDir, { recursive: true, force: true });
	});

	it("does nothing (no marker write) when no local objectives files exist", async () => {
		const repo = createFakeObjectivesRepository();
		await migrateLegacyObjectivesStore(sharedDir, missionId, repo);
		expect(await repo.hasGoalsDoc(missionId)).toBe(false);
	});

	it("imports goals.json + tasks.jsonl + kpis.jsonl + cost.jsonl + alloc.jsonl into the repo", async () => {
		const dir = join(sharedDir, "objectives");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "goals.json"),
			JSON.stringify({
				objectives: [
					{
						id: "OBJ-1",
						parent: null,
						title: "root",
						owner: "alice",
						status: "active",
						kpis: [],
					},
				],
			}),
		);
		writeFileSync(
			join(dir, "tasks.jsonl"),
			`${JSON.stringify({
				id: "T1",
				at: "2026-07-01T00:00:00.000Z",
				by: "alice",
				title: "do it",
				objective: "OBJ-1",
				status: "completed",
			})}\n`,
		);
		writeFileSync(
			join(dir, "kpis.jsonl"),
			`${JSON.stringify({
				kpi: "K1",
				value: "met",
				by: "alice",
				at: "2026-07-01T00:01:00.000Z",
			})}\n`,
		);
		writeFileSync(
			join(dir, "cost.jsonl"),
			`${JSON.stringify({
				turn: 1,
				agent: "alice",
				at: "2026-07-01T00:02:00.000Z",
				alloc: { T1: 0.5 },
			})}\n`,
		);
		writeFileSync(
			join(dir, "alloc.jsonl"),
			`${JSON.stringify({
				by: "alice",
				at: "2026-07-01T00:03:00.000Z",
				key: { "TASK-1": 100 },
			})}\n`,
		);

		const repo = createFakeObjectivesRepository();
		await migrateLegacyObjectivesStore(sharedDir, missionId, repo);

		expect(await repo.hasGoalsDoc(missionId)).toBe(true);
		const tree = await repo.readTree(missionId);
		expect(tree.objectives[0].id).toBe("OBJ-1");
		expect(tree.tasks[0].status).toBe("completed");
		expect(tree.tasks[0].costUsd).toBeCloseTo(0.5);
		expect(tree.objectives[0].kpis).toEqual([]); // no KPI *definitions* — K1 event has nothing to attach to
		expect(await repo.readAllocEvents(missionId)).toHaveLength(1);
	});

	it("is idempotent — a second call does not duplicate events", async () => {
		const dir = join(sharedDir, "objectives");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "goals.json"), JSON.stringify({ objectives: [] }));
		writeFileSync(
			join(dir, "tasks.jsonl"),
			`${JSON.stringify({
				id: "T1",
				at: "2026-07-01T00:00:00.000Z",
				by: "alice",
				status: "open",
			})}\n`,
		);

		const repo = createFakeObjectivesRepository();
		await migrateLegacyObjectivesStore(sharedDir, missionId, repo);
		await migrateLegacyObjectivesStore(sharedDir, missionId, repo); // resume again

		const events = await repo.readTaskEvents(missionId);
		expect(events).toHaveLength(1); // not duplicated
	});

	it("writes an empty goals marker (still migrates) when only tasks.jsonl exists", async () => {
		const dir = join(sharedDir, "objectives");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "tasks.jsonl"),
			`${JSON.stringify({
				id: "T1",
				at: "2026-07-01T00:00:00.000Z",
				by: "alice",
				status: "open",
			})}\n`,
		);

		const repo = createFakeObjectivesRepository();
		await migrateLegacyObjectivesStore(sharedDir, missionId, repo);

		expect(await repo.hasGoalsDoc(missionId)).toBe(true);
		expect(await repo.readGoals(missionId)).toEqual({ objectives: [] });
		expect(await repo.readTaskEvents(missionId)).toHaveLength(1);
	});

	it("skips already-migrated missions without touching local files further", async () => {
		const repo = createFakeObjectivesRepository();
		await repo.saveGoals(missionId, { objectives: [] }, "migration");

		// Local files exist but hasGoalsDoc is already true — must no-op entirely.
		const dir = join(sharedDir, "objectives");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "tasks.jsonl"),
			`${JSON.stringify({
				id: "T1",
				at: "2026-07-01T00:00:00.000Z",
				by: "alice",
				status: "open",
			})}\n`,
		);

		await migrateLegacyObjectivesStore(sharedDir, missionId, repo);
		expect(await repo.readTaskEvents(missionId)).toHaveLength(0);
	});
});
