/**
 * One-time boot-time migration of a mission's legacy file-based objectives
 * store (`sharedDir/objectives/{goals.json,tasks.jsonl,kpis.jsonl,cost.jsonl,
 * alloc.jsonl}`) into MongoDB (ADR-0019).
 *
 * Objectives files live on a per-mission Fly volume, only reachable when that
 * mission's own daemon is running — unlike ADR-0021's config migration, this
 * cannot run as one standalone script against Mongo directly. Instead, every
 * mission migrates itself the next time it resumes: this function runs from
 * `daemon.ts`'s onWorkspaceReady, before any seeding, and is a no-op after the
 * first successful run (or for a mission that never had file-based objectives
 * at all — the common case).
 *
 * Local files are never deleted afterward — an inert backup on the volume,
 * same precedent as ADR-0021 leaving stale `teamConfigYaml` in place. This
 * file's read functions are migration-only and must not be reused elsewhere —
 * everything else in the codebase reads/writes through `ObjectivesRepository`.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectivesRepository } from "./repository.js";
import {
	AllocEventSchema,
	CostEventSchema,
	GoalsFileSchema,
	KpiEventSchema,
	STORE_FILES,
	TaskEventSchema,
} from "./types.js";

async function readJsonl<T>(
	path: string,
	parse: (o: unknown) => T,
): Promise<T[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw e;
	}
	const out: T[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(parse(JSON.parse(trimmed)));
		} catch (err) {
			console.warn(
				`[objectives-migration] skipping malformed line in ${path}: ${(err as Error).message}`,
			);
		}
	}
	return out;
}

/** Migrate a mission's on-disk legacy objectives store into Mongo, once. */
export async function migrateLegacyObjectivesStore(
	sharedDir: string,
	missionId: string,
	repo: ObjectivesRepository,
): Promise<void> {
	if (await repo.hasGoalsDoc(missionId)) return; // already migrated (or Mongo-native from the start)

	const dir = join(sharedDir, "objectives");
	if (!existsSync(dir)) return; // never used objectives — nothing to migrate, no marker written

	const goalsPath = join(dir, STORE_FILES.goals);
	let goals: { objectives: unknown[] } = { objectives: [] };
	if (existsSync(goalsPath)) {
		try {
			goals = GoalsFileSchema.parse(
				JSON.parse(await readFile(goalsPath, "utf8")),
			);
		} catch (e) {
			console.warn(
				`[objectives-migration] ignoring invalid legacy goals.json for mission ${missionId}: ${(e as Error).message}`,
			);
		}
	}

	const [taskEvents, kpiEvents, costEvents, allocEvents] = await Promise.all([
		readJsonl(join(dir, STORE_FILES.tasks), (o) => TaskEventSchema.parse(o)),
		readJsonl(join(dir, STORE_FILES.kpis), (o) => KpiEventSchema.parse(o)),
		readJsonl(join(dir, STORE_FILES.cost), (o) => CostEventSchema.parse(o)),
		readJsonl(join(dir, STORE_FILES.alloc), (o) => AllocEventSchema.parse(o)),
	]);

	// Always write the goals doc, even empty — its existence is the migrated
	// marker checked by hasGoalsDoc() above, so this mission is never rescanned.
	await repo.saveGoals(
		missionId,
		{ objectives: goals.objectives as never },
		"migration",
	);
	for (const ev of taskEvents) await repo.appendTaskEvent(missionId, ev);
	for (const ev of kpiEvents) await repo.appendKpiEvent(missionId, ev);
	for (const ev of costEvents) await repo.appendCostEvent(missionId, ev);
	for (const ev of allocEvents) await repo.appendAllocEvent(missionId, ev);

	console.log(
		`[objectives-migration] migrated mission ${missionId}: ${taskEvents.length} task, ${kpiEvents.length} kpi, ${costEvents.length} cost, ${allocEvents.length} alloc event(s), ${(goals.objectives as unknown[]).length} objective(s)`,
	);
}
