/**
 * Every entry point of MAGI (route, tool, copilot action, Tool API name,
 * trigger) declares the operation it serves, or an entry class (ADR-0036).
 * The scan is scripts/trace/entry-points.mjs; `tsc` already rejects an
 * unknown id where the tag is typed, and this test catches a missing tag
 * where the type cannot (routes registered directly on a router, timers,
 * change streams).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractEntryPoints } from "../../../scripts/trace/entry-points.mjs";
import { ENTRY_CLASSES, OPERATIONS } from "../src/baseline/index.js";

interface EntryPoint {
	kind: string;
	actor: string;
	file: string;
	line: number;
	name: string;
	tag: string | null;
}

const entries: EntryPoint[] = extractEntryPoints();
const where = (e: EntryPoint) => `${e.file}:${e.line} ${e.kind} ${e.name}`;

describe("entry points", () => {
	it("are found in every kind", () => {
		const kinds = new Set(entries.map((e) => e.kind));
		expect([...kinds].sort()).toEqual(
			[
				"copilot-action",
				"monitor-route",
				"route",
				"tool",
				"tool-api",
				"trigger",
			].sort(),
		);
	});

	it("each declare an operation or an entry class", () => {
		expect(entries.filter((e) => e.tag === null).map(where)).toEqual([]);
	});

	it("name only ids of the catalog", () => {
		const ids = new Set<string>([
			...OPERATIONS.map((o) => o.id),
			...ENTRY_CLASSES.map((c) => c.id),
		]);
		expect(
			entries
				.filter((e) => e.tag !== null && !ids.has(e.tag))
				.map((e) => `${where(e)}: ${e.tag}`),
		).toEqual([]);
	});
});

describe("the entry-point scan", () => {
	const root = mkdtempSync(join(tmpdir(), "entry-points-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const cp = join(root, "packages/control-plane/src");
	const mm = join(root, "packages/agent-runtime-worker/src");
	mkdirSync(cp, { recursive: true });
	mkdirSync(mm, { recursive: true });
	writeFileSync(
		join(cp, "routes.ts"),
		[
			'routes.get("/tagged", "mission.status", h);',
			'router.post("/marked", operation("mission.launch"), h);',
			'router.post("/bare", h);',
			'schedule("* * * * *", tick);',
			'schedule("*/5 * * * *", entryTrigger("oversight.alert", tick));',
			"setInterval(() => sweep(), 1000);",
			"function open() { const s = col.watch([]); s.on('change', entryTrigger('copilot.wake', f)); }",
			"function bare() { col.watch([]).on('change', f); }",
		].join("\n"),
	);
	writeFileSync(
		join(mm, "tools.ts"),
		[
			'const a = { name: "Tagged", operation: "agent.shell", execute() {} };',
			'const b = { name: "Bare", execute() {} };',
			'const r = { method: "GET", path: /^\\/x$/, handler: h };',
		].join("\n"),
	);
	const found: EntryPoint[] = extractEntryPoints(root);
	const tagOf = (name: string) => found.find((e) => e.name === name)?.tag;

	it("reads each form of tag", () => {
		expect(tagOf("GET /tagged")).toBe("mission.status");
		expect(tagOf("POST /marked")).toBe("mission.launch");
		expect(tagOf("cron */5 * * * *: tick")).toBe("oversight.alert");
		expect(tagOf("change event")).toBe("copilot.wake");
		expect(tagOf("Tagged")).toBe("agent.shell");
	});

	it("reports every untagged form", () => {
		expect(
			found
				.filter((e) => e.tag === null)
				.map((e) => `${e.kind} ${e.name}`)
				.sort(),
		).toEqual(
			[
				"monitor-route GET /^\\/x$/",
				"route POST /bare",
				"tool Bare",
				"trigger change stream",
				"trigger cron * * * * *",
				"trigger interval",
			].sort(),
		);
	});
});
