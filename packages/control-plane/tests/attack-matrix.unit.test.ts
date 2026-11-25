/**
 * docs/security/attack-matrix.md is current, and every cell it marks covered names a test that
 * exists and carries the cell's name (an it() title fragment, or a sandbox cell id).
 * Regenerate with `npm run docs:matrix` (after `npm run trace` to refresh the entry points).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildMatrix,
	CLAIMED_ROWS_CEILING,
	loadEntries,
	loadThreatRows,
	renderMarkdown,
} from "../../../scripts/security/matrix/matrix.mjs";

const ROOT = join(__dirname, "..", "..", "..");

interface Cell {
	status: "covered" | "open" | "n/a";
	by: { test: string; name: string } | null;
	reason: string | null;
	row: { surface: string; method: string; path: string };
	cls: { id: string };
}

describe("attack matrix document", () => {
	const cells: Cell[] = buildMatrix(loadEntries());

	it("docs/security/attack-matrix.md is current (npm run docs:matrix)", () => {
		const onDisk = readFileSync(
			join(ROOT, "docs", "security", "attack-matrix.md"),
			"utf8",
		);
		expect(onDisk).toBe(renderMarkdown(cells));
	});

	it("every covered cell names a test that exists and carries the cell's name", () => {
		const missing: string[] = [];
		const sources = new Map<string, string>();
		for (const c of cells.filter((x) => x.status === "covered")) {
			if (!c.by) throw new Error("covered cell without a test");
			const file = join(ROOT, c.by.test);
			if (!sources.has(file))
				sources.set(file, existsSync(file) ? readFileSync(file, "utf8") : "");
			const src = sources.get(file) ?? "";
			const named = c.by.name
				.split(", ")
				.every((n) =>
					c.by?.test.endsWith(".py") ? src.includes(`"${n}"`) : src.includes(n),
				);
			if (!named)
				missing.push(
					`${c.row.method} ${c.row.path} ${c.cls.id} → ${c.by.test} (${c.by.name})`,
				);
		}
		expect(missing).toEqual([]);
	});

	it("every n/a cell gives its reason", () => {
		expect(cells.filter((c) => c.status === "n/a" && !c.reason)).toEqual([]);
	});

	it("every HTTP operation and every trace entry point has a cell", () => {
		const has = (surface: string, method: string, path: string) =>
			cells.some(
				(c) =>
					c.row.surface === surface &&
					c.row.path === path &&
					(c.row.method === method || c.row.method === "*"),
			);
		const without: string[] = [];
		for (const surface of [
			"control-plane",
			"apps-host",
			"monitor",
			"tool-api",
		]) {
			const spec = JSON.parse(
				readFileSync(
					join(ROOT, "docs", "api", `${surface}.openapi.json`),
					"utf8",
				),
			);
			for (const [path, item] of Object.entries(
				spec.paths as Record<string, Record<string, unknown>>,
			)) {
				for (const method of Object.keys(item))
					if (!has(surface, method.toUpperCase(), path))
						without.push(`${surface} ${method} ${path}`);
			}
		}
		const kinds: Record<string, string> = {
			tool: "tool",
			"file-request": "request-folder",
			"copilot-action": "copilot-action",
			trigger: "trigger",
		};
		for (const e of loadEntries() as { kind: string; name: string }[]) {
			const surface = kinds[e.kind];
			if (surface && !cells.some((c) => c.row.surface === surface))
				without.push(`${e.kind} ${e.name}`);
		}
		expect(without).toEqual([]);
	});
});

interface ThreatRow {
	boundary: string;
	threat: string;
	status: string;
	proofs: { test: string; name: string | null; missing?: boolean }[];
}

describe("the threat model, connected to the matrix", () => {
	const rows: ThreatRow[] = loadThreatRows();
	const threatModel = readFileSync(
		join(ROOT, "docs", "security", "threat-model.md"),
		"utf8",
	);

	it("every proof a STRIDE row cites exists, and a sandbox cell it names is in the sandbox", () => {
		const bad: string[] = [];
		const sandbox = readFileSync(
			join(ROOT, "scripts/security/sandbox/sandbox.py"),
			"utf8",
		);
		for (const r of rows) {
			for (const p of r.proofs) {
				if (p.missing || !existsSync(join(ROOT, p.test)))
					bad.push(`${r.boundary} "${r.threat}": ${p.test} does not exist`);
				else if (p.name && !sandbox.includes(`"${p.name}"`))
					bad.push(`${r.boundary} "${r.threat}": no sandbox cell ${p.name}`);
			}
		}
		expect(bad).toEqual([]);
	});

	it(`mitigated rows that only claim it stay at or under ${CLAIMED_ROWS_CEILING} (lower the ceiling as proofs are added)`, () => {
		const claimed = rows.filter(
			(r) => r.status === "mitigated" && r.proofs.length === 0,
		);
		expect(claimed.length).toBeLessThanOrEqual(CLAIMED_ROWS_CEILING);
	});

	it("every matrix row but a timer names a boundary the threat model defines", () => {
		const defined = new Set(
			threatModel.match(/\*\*TB-\d+\*\*/g)?.map((t) => t.slice(2, -2)),
		);
		const rowsOf = buildMatrix(loadEntries()).map(
			(c: Cell & { row: { boundaries: string[] } }) => c.row,
		);
		const wrong = rowsOf
			.filter((r: { surface: string }) => r.surface !== "trigger")
			.filter(
				(r: { boundaries: string[] }) =>
					r.boundaries.length === 0 ||
					r.boundaries.some((b) => !defined.has(b)),
			)
			.map((r: { surface: string; path: string }) => `${r.surface} ${r.path}`);
		expect([...new Set(wrong)]).toEqual([]);
	});
});
