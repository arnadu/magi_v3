/**
 * Cross-checks the menu table in packages/skills/request-resources/SKILL.md
 * against machine-shapes.ts's own buildMenu() — the ADR-0031 rule that the
 * skill's numbers are "regenerated from the price table, never hand-edited".
 * Fails if either drifts from the other: a code change to the price table or
 * the menu shapes without updating the skill, or vice versa.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildMenu,
	DEFAULT_MACHINE,
	estimateCostPerHourUsd,
	validateUpgradeRequest,
} from "../src/machine-shapes.js";

const REPO_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);
const SKILL_PATH = join(
	REPO_ROOT,
	"packages",
	"skills",
	"request-resources",
	"SKILL.md",
);

interface MenuRow {
	name: string;
	cpuKind: string;
	cpus: number;
	memoryMb: number;
	usdPerHour: number;
}

/** Parses the one markdown table in the skill with columns Shape/kind/CPUs/RAM/≈ $/h. */
function parseMenuTable(markdown: string): MenuRow[] {
	const lines = markdown.split("\n");
	const headerIdx = lines.findIndex((l) => l.startsWith("| Shape | kind"));
	if (headerIdx === -1)
		throw new Error("menu table header not found in SKILL.md");

	const rows: MenuRow[] = [];
	for (const line of lines.slice(headerIdx + 2)) {
		if (!line.startsWith("|")) break;
		const cells = line
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());
		const [name, cpuKind, cpusText, ramText, usdText] = cells;
		const ramMatch = ramText.match(/^([\d.]+)\s*GB$/);
		if (!ramMatch) throw new Error(`unparseable RAM cell: "${ramText}"`);
		rows.push({
			name,
			cpuKind,
			cpus: Number(cpusText),
			memoryMb: Number(ramMatch[1]) * 1024,
			usdPerHour: Number(usdText),
		});
	}
	return rows;
}

describe("request-resources skill menu vs. machine-shapes.buildMenu()", () => {
	const skillRows = parseMenuTable(readFileSync(SKILL_PATH, "utf-8"));
	const codeMenu = buildMenu();

	it("parses at least the default row plus every buildMenu() entry", () => {
		expect(skillRows.length).toBe(codeMenu.length + 1);
	});

	it("lists the default machine first, matching DEFAULT_MACHINE, and does not price-validate it as an upgrade", () => {
		const [first] = skillRows;
		expect(first.name).toBe("default (today)");
		expect({
			cpuKind: first.cpuKind,
			cpus: first.cpus,
			memoryMb: first.memoryMb,
		}).toEqual(DEFAULT_MACHINE);
	});

	it.each(
		buildMenu().map((entry) => [entry.name, entry] as const),
	)("%s: shape and price match buildMenu() exactly", (_name, entry) => {
		const row = skillRows.find((r) => r.name === entry.name);
		expect(row, `skill has no row named "${entry.name}"`).toBeDefined();
		expect({
			cpuKind: row?.cpuKind,
			cpus: row?.cpus,
			memoryMb: row?.memoryMb,
		}).toEqual(entry.shape);
		// The skill rounds for readability; require it to round the live
		// figure correctly rather than hand-typing an independent number.
		const rounded = Number(entry.costPerHourUsd.toFixed(3)).toString();
		const twoDp = entry.costPerHourUsd.toFixed(2);
		expect([rounded, twoDp]).toContain(String(row?.usdPerHour));
	});

	it("every menu row (skill and code) validates as a real, allowed upgrade shape", () => {
		for (const row of skillRows.slice(1)) {
			const result = validateUpgradeRequest({
				cpuKind: row.cpuKind,
				cpus: row.cpus,
				memoryMb: row.memoryMb,
				durationMinutes: 30,
			});
			expect(result.ok, `${row.name}: ${!result.ok && result.error}`).toBe(
				true,
			);
		}
	});

	it("the default row's own price is a positive, sane estimate", () => {
		expect(estimateCostPerHourUsd(DEFAULT_MACHINE)).toBeGreaterThan(0);
	});
});
