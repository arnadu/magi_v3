/**
 * The environment contract (R-8): the variables the code reads, the catalog
 * that documents them, and docs/env.md must agree. Run with
 * UPDATE_ENV_DOC=1 (npm run docs:env) to rewrite the doc after a catalog edit.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_CATALOG, renderEnvDoc } from "../src/env-catalog.js";

const ROOT = join(__dirname, "..", "..", "..");

function* sources(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist") continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) yield* sources(p);
		else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) yield p;
	}
}

/** Names read as `process.env.X` or `env.X` (an injected ProcessEnv) in any package's src. */
function namesReadBySource(): Map<string, string> {
	const found = new Map<string, string>();
	for (const pkg of readdirSync(join(ROOT, "packages"))) {
		const src = join(ROOT, "packages", pkg, "src");
		try {
			statSync(src);
		} catch {
			continue;
		}
		for (const file of sources(src)) {
			if (file.endsWith("env-catalog.ts")) continue;
			const text = readFileSync(file, "utf8");
			for (const m of text.matchAll(
				/\b(?:process\.)?env\.([A-Z][A-Z0-9_]+)\b/g,
			)) {
				if (!found.has(m[1])) found.set(m[1], file.slice(ROOT.length + 1));
			}
		}
	}
	return found;
}

describe("environment catalog", () => {
	const read = namesReadBySource();
	const declared = new Set(ENV_CATALOG.map((v) => v.name));

	it("declares every variable the code reads", () => {
		const undeclared = [...read].filter(([n]) => !declared.has(n));
		expect(undeclared, "add these to env-catalog.ts").toEqual([]);
	});

	it("declares nothing the code no longer reads", () => {
		const dead = [...declared].filter((n) => !read.has(n));
		expect(dead, "remove these from env-catalog.ts").toEqual([]);
	});

	it("has one entry per name", () => {
		expect(declared.size).toBe(ENV_CATALOG.length);
	});

	it("docs/env.md is the rendered catalog", () => {
		const path = join(ROOT, "docs", "env.md");
		const rendered = renderEnvDoc();
		if (process.env.UPDATE_ENV_DOC === "1") writeFileSync(path, rendered);
		expect(readFileSync(path, "utf8")).toBe(rendered);
	});
});
