import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCatalog } from "../src/catalog-routes.js";

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("readCatalog", () => {
	it("lists every skill directory that has a SKILL.md, sorted, and the worker's tool names", () => {
		root = mkdtempSync(join(tmpdir(), "magi-catalog-"));
		for (const name of ["schedule-task", "git-provenance", "no-skill-md"]) {
			mkdirSync(join(root, "packages", "skills", name), { recursive: true });
		}
		writeFileSync(join(root, "packages/skills/schedule-task/SKILL.md"), "x");
		writeFileSync(join(root, "packages/skills/git-provenance/SKILL.md"), "x");
		const c = readCatalog(root);
		expect(c.platformSkills).toEqual(["git-provenance", "schedule-task"]);
		expect(c.tierATools).toContain("mental_map_update");
		expect(c.tierATools).not.toContain("UpdateMentalMap");
	});

	it("matches the real skills directory of this repo", () => {
		root = mkdtempSync(join(tmpdir(), "magi-catalog-")); // cleaned up, unused
		const c = readCatalog(join(__dirname, "..", "..", ".."));
		expect(c.platformSkills).toContain("schedule-task");
		expect(c.platformSkills).not.toContain("market-analysis-framework");
	});
});
