/**
 * The product and architecture baselines (src/baseline/): ids unique, every
 * source file placed in exactly one component, and the documents under
 * docs/product/ and docs/architecture/ rendered from the catalog.
 * UPDATE_BASELINE_DOC=1 (npm run docs:baseline) rewrites the documents.
 * References between baselines (an operation's actors and home, a journey's
 * operations, a transition's states) are checked by `tsc`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ACTORS,
	COMPONENTS,
	componentsOwning,
	ENTITIES,
	JOURNEYS,
	OPERATIONS,
	patternOwns,
	renderBaselineDocs,
} from "../src/baseline/index.js";

const ROOT = join(__dirname, "..", "..", "..");

function* files(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist") continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) yield* files(p);
		else yield relative(ROOT, p);
	}
}

const ROOTS = [...new Set(COMPONENTS.map((c) => c.root))];
const SOURCES = ROOTS.flatMap((r) => [...files(join(ROOT, r))]);

function duplicates(ids: readonly string[]): string[] {
	return ids.filter((id, i) => ids.indexOf(id) !== i);
}

describe("baseline catalog", () => {
	it("has unique ids", () => {
		expect(duplicates(ACTORS.map((a) => a.id))).toEqual([]);
		expect(duplicates(COMPONENTS.map((c) => c.id))).toEqual([]);
		expect(duplicates(ENTITIES.map((e) => e.id))).toEqual([]);
		expect(duplicates(OPERATIONS.map((o) => o.id))).toEqual([]);
		expect(duplicates(JOURNEYS.map((j) => j.id))).toEqual([]);
		expect(
			duplicates(ENTITIES.flatMap((e) => e.invariants.map((i) => i.id))),
		).toEqual([]);
		for (const e of ENTITIES) {
			expect(duplicates(e.states.map((s) => s.id)), e.id).toEqual([]);
		}
	});

	it("places every source file in exactly one component", () => {
		const problems = SOURCES.map((f) => ({ f, owners: componentsOwning(f) }))
			.filter((x) => x.owners.length !== 1)
			.map((x) => `${x.f}: ${x.owners.join(", ") || "no component"}`);
		expect(problems).toEqual([]);
	});

	it("has no path pattern that owns nothing", () => {
		const dead = COMPONENTS.flatMap((c) =>
			c.paths
				.filter(
					(p) =>
						!SOURCES.some(
							(f) =>
								f.startsWith(`${c.root}/`) &&
								patternOwns(p, f.slice(c.root.length + 1)),
						),
				)
				.map((p) => `${c.id}: ${p}`),
		);
		expect(dead).toEqual([]);
	});

	it("puts every operation in a journey, or says why not", () => {
		const inJourney = new Set(JOURNEYS.flatMap((j) => j.operations));
		const without = OPERATIONS.filter((o) => !inJourney.has(o.id)).map(
			(o) => o.id,
		);
		// Platform operations and the copilot's settings are not steps an
		// operator takes; they are covered by the journeys that depend on them.
		expect(without.sort()).toEqual(
			[
				"copilot.dismiss",
				"copilot.limits",
				"copilot.settings",
				"image.create",
				"job.submit",
				"mission.create",
				"mission.reconcile",
				"task.update",
			].sort(),
		);
	});

	it("renders docs/product and docs/architecture from the catalog", () => {
		for (const [path, rendered] of Object.entries(renderBaselineDocs())) {
			const abs = join(ROOT, path);
			if (process.env.UPDATE_BASELINE_DOC === "1") writeFileSync(abs, rendered);
			expect(readFileSync(abs, "utf8"), path).toBe(rendered);
		}
	});
});
