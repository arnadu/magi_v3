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
import { FINDING_KINDS } from "../../../scripts/trace/findings.mjs";
import {
	ACTORS,
	COMPONENTS,
	componentsOwning,
	DATA_STORES,
	ENTITIES,
	ENTRY_CLASSES,
	JOURNEYS,
	OPERATIONS,
	PLATFORM_INVARIANTS,
	patternOwns,
	renderBaselineDocs,
	SECURITY_INVARIANTS,
} from "../src/baseline/index.js";
import { COLLECTION_NAMES } from "../src/stored/collections.js";

const ROOT = join(__dirname, "..", "..", "..");

function* files(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist") continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) yield* files(p);
		else yield relative(ROOT, p);
	}
}

function statSafe(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

const ROOTS = [...new Set(COMPONENTS.map((c) => c.root))];
const SOURCES = ROOTS.flatMap((r) => [...files(join(ROOT, r))]);

const INVARIANTS = [
	...ENTITIES.flatMap((e) => e.invariants),
	...PLATFORM_INVARIANTS,
	...SECURITY_INVARIANTS,
];

/** Every test title in the repository's unit and integration tests. */
const TEST_SOURCES = ROOTS.flatMap((r) => {
	const tests = join(ROOT, r.replace(/\/src$/, ""), "tests");
	try {
		return [...files(tests)].map((f) => readFileSync(join(ROOT, f), "utf8"));
	} catch {
		return [];
	}
});

/** The skills' Python tests (pytest, run in CI): a test names an invariant at the start of its docstring. */
const PYTHON_TEST_SOURCES = [...files(join(ROOT, "tests"))]
	.filter((f) => f.endsWith(".py"))
	.map((f) => readFileSync(join(ROOT, f), "utf8"));

/**
 * What is wrong with a runtime enforcement's `where`: "<package path>: <what>",
 * several joined by "; " (a bare file name is in the previous one's folder).
 * <what> starts with the function names (camelCase, comma-separated) or a
 * route path ("/confirm"); each must still be in that file. A description in
 * words ("the team config schema") names no symbol to check.
 */
function runtimeLocationProblems(where: string): string[] {
	const problems: string[] = [];
	let dir = "";
	for (const part of where.split("; ")) {
		const m = /^([\w./-]+\.tsx?): (.*)$/.exec(part);
		if (!m) {
			problems.push(`"${part}" is not "<file>: <what>"`);
			continue;
		}
		const file = m[1].includes("/") ? m[1] : `${dir}/${m[1]}`;
		dir = file.slice(0, file.lastIndexOf("/"));
		const path = join(ROOT, "packages", file);
		if (!statSafe(path)) {
			problems.push(`no file packages/${file}`);
			continue;
		}
		const text = readFileSync(path, "utf8");
		const names = /^((?:[a-z]+[A-Z]\w*)(?:, [a-z]+[A-Z]\w*)*)/.exec(m[2]);
		for (const name of names ? names[1].split(", ") : [])
			if (!hasWord(text, name)) problems.push(`no ${name} in packages/${file}`);
		const route = /^(\/[\w/-]+)/.exec(m[2]);
		if (route && !text.includes(`"${route[1]}"`))
			problems.push(`no route "${route[1]}" in packages/${file}`);
	}
	return problems;
}

/** Whether `name` occurs in `text` as a whole word (not inside a longer identifier). */
function hasWord(text: string, name: string): boolean {
	const isWordChar = (c: string | undefined) => c !== undefined && /\w/.test(c);
	for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1))
		if (!isWordChar(text[i - 1]) && !isWordChar(text[i + name.length]))
			return true;
	return false;
}

/** What is missing for one way an invariant is enforced. */
function enforcementProblems(
	id: string,
	e: (typeof INVARIANTS)[number]["enforcedBy"][number],
): string[] {
	switch (e.kind) {
		case "test":
			return TEST_SOURCES.some((t) => t.includes(`("${id}`)) ||
				PYTHON_TEST_SOURCES.some((t) => t.includes(`"""${id}`))
				? []
				: [`no test titled "${id} …"`];
		case "scan":
			return SOURCES.includes(`scripts/trace/ql/${e.query}.ql`) ||
				statSafe(join(ROOT, `scripts/trace/ql/${e.query}.ql`))
				? []
				: [`no query ${e.query}`];
		case "runtime":
			return runtimeLocationProblems(e.where);
		default:
			return [];
	}
}

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
		expect(duplicates(INVARIANTS.map((i) => i.id))).toEqual([]);
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

	it("puts every operation an actor asks for in a journey (D10)", () => {
		// Only the platform's own operations (timers, events, steps another
		// operation starts) may have no journey; their rules check them.
		const inJourney = new Set<string>(JOURNEYS.flatMap((j) => j.operations));
		const without = OPERATIONS.filter(
			(o) => o.actors.some((a) => a !== "PLT") && !inJourney.has(o.id),
		).map((o) => o.id);
		expect(without).toEqual([]);
	});

	it("names an existing parent for a step another operation starts (D8)", () => {
		const ids = new Set<string>(OPERATIONS.map((o) => o.id));
		const wrong = OPERATIONS.filter(
			(o) =>
				o.startedBy !== undefined &&
				(!ids.has(o.startedBy) ||
					o.startedBy === o.id ||
					o.actors.some((a) => a !== "PLT")),
		).map((o) => o.id);
		expect(wrong).toEqual([]);
	});

	it("gives every collection exactly one data store, with its owner", () => {
		const listed = DATA_STORES.map((d) => d.collection);
		expect(duplicates(listed)).toEqual([]);
		expect([...listed].sort()).toEqual(Object.keys(COLLECTION_NAMES).sort());
	});

	it("links invariants only to ADRs and enforcements that exist", () => {
		const adrs = readdirSync(join(ROOT, "docs/adr"));
		const problems: string[] = [];
		for (const inv of INVARIANTS) {
			if (inv.decidedBy) {
				const n = inv.decidedBy.slice(4);
				if (!adrs.some((f) => f.startsWith(`${n}-`)))
					problems.push(`${inv.id}: no ${inv.decidedBy}`);
			}
			for (const e of inv.enforcedBy)
				for (const p of enforcementProblems(inv.id, e))
					problems.push(`${inv.id}: ${p}`);
		}
		expect(problems).toEqual([]);
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

describe("catalog ids used outside the catalog", () => {
	const MAGI_DEV = [
		"config/teams/magi-dev.yaml",
		...files(join(ROOT, "config/teams/magi-dev")),
	];

	it("names only journeys that exist in MAGI DEV's template", () => {
		const journeys = new Set(JOURNEYS.map((j) => j.id));
		const unknown = MAGI_DEV.flatMap((f) =>
			[...readFileSync(join(ROOT, f), "utf8").matchAll(/\b[JA]-\d{2}[a-z]?\b/g)]
				.map((m) => m[0])
				.filter((id) => !journeys.has(id))
				.map((id) => `${f}: ${id}`),
		);
		expect(unknown).toEqual([]);
	});

	it("covers only finding kinds the trace reports, about ids that exist", () => {
		const coverage = JSON.parse(
			readFileSync(
				join(ROOT, "config/teams/magi-dev/team/coverage.json"),
				"utf8",
			),
		) as { agents: Record<string, string[]> };
		const ids = [
			...ACTORS.map((a) => a.id),
			...COMPONENTS.map((c) => c.id),
			...ENTITIES.map((e) => e.id),
			...OPERATIONS.map((o) => o.id),
			...INVARIANTS.map((i) => i.id),
		];
		const problems = Object.entries(coverage.agents).flatMap(
			([agent, selectors]) =>
				selectors.flatMap((s) => {
					const [kind, prefix] = s.split(":");
					if (!(FINDING_KINDS as readonly string[]).includes(kind))
						return [`${agent}: no finding kind ${kind}`];
					if (prefix && !ids.some((id) => id.startsWith(prefix)))
						return [`${agent}: no catalog id starts with ${prefix}`];
					return [];
				}),
		);
		expect(problems).toEqual([]);
	});
});
