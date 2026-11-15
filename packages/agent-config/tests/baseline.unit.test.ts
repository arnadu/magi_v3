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
	ENTRY_CLASSES,
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
			duplicates([
				...OPERATIONS.map((o) => o.id),
				...ENTRY_CLASSES.map((c) => c.id),
			]),
		).toEqual([]);
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

	it("puts every operation the operator or a copilot can ask for in a journey", () => {
		// Operations asked only by agents, jobs or the platform are steps
		// inside the team's own work; the journeys that depend on them cover
		// them.
		const operatorSide = new Set(["OP", "ADM", "CC", "MC"]);
		const inJourney = new Set<string>(JOURNEYS.flatMap((j) => j.operations));
		const without = OPERATIONS.filter(
			(o) => o.actors.some((a) => operatorSide.has(a)) && !inJourney.has(o.id),
		).map((o) => o.id);
		expect(without).toEqual([]);
	});

	it("matches path patterns as documented", () => {
		expect(patternOwns("loop*.ts", "loop.ts")).toBe(true);
		expect(patternOwns("loop*.ts", "loop-steps.ts")).toBe(true);
		expect(patternOwns("loop*.ts", "loop/x.ts")).toBe(false);
		expect(patternOwns("loop*.ts", "loop.tsx")).toBe(false);
		expect(patternOwns("a*b*c", "axxbyyc")).toBe(true);
		expect(patternOwns("a*b*c", "abc")).toBe(true);
		expect(patternOwns("a*b*c", "ab/c")).toBe(false);
		expect(patternOwns("index.ts", "sub/index.ts")).toBe(false);
		expect(patternOwns("tools/", "tools/bash.ts")).toBe(true);
		expect(patternOwns("tools/", "tools.ts")).toBe(false);
		expect(patternOwns("**", "any/depth/file.ts")).toBe(true);
	});

	it("renders docs/product and docs/architecture from the catalog", () => {
		for (const [path, rendered] of Object.entries(renderBaselineDocs())) {
			const abs = join(ROOT, path);
			if (process.env.UPDATE_BASELINE_DOC === "1") writeFileSync(abs, rendered);
			expect(readFileSync(abs, "utf8"), path).toBe(rendered);
		}
	});
});
