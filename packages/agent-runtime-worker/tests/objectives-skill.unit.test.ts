/**
 * Objectives skill scripts — acceptance test (Sprint 26a, deliverable A2).
 *
 * Runs the append-only skill scripts (task-add / task-update / record-kpi) the
 * way an agent would (SHARED_DIR + AGENT_ID in the env), then folds the store
 * with the A1 lib and asserts the events round-trip. Also asserts the scripts
 * make NO git calls (no .git is created; they only append).
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadObjectivesStore } from "../src/objectives/store.js";

const SCRIPTS = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"skills",
	"objectives",
	"scripts",
);

let shared: string;
const AGENT = "records-officer";

function run(script: string, args: string[]): string {
	return execFileSync("bash", [join(SCRIPTS, script), ...args], {
		encoding: "utf8",
		env: { ...process.env, SHARED_DIR: shared, AGENT_ID: AGENT },
	}).trim();
}

beforeEach(() => {
	shared = mkdtempSync(join(tmpdir(), "obj-skill-"));
});
afterEach(() => {
	rmSync(shared, { recursive: true, force: true });
});

describe("objectives skill scripts", () => {
	it("task-add appends a create event the fold reads back", async () => {
		const id = run("task-add.sh", [
			"--title",
			"Pull NVDA prices",
			"--objective",
			"OBJ-1",
			"--priority",
			"high",
		]);
		expect(id).toMatch(/^TASK-/);

		const tree = await loadObjectivesStore(shared);
		const t = tree.tasks.find((x) => x.id === id);
		expect(t?.title).toBe("Pull NVDA prices");
		expect(t?.status).toBe("open");
		expect(t?.assignee).toBe(AGENT); // defaulted to AGENT_ID
		expect(t?.priority).toBe("high");
		// no goals.json → the task is an orphan, but still folds
		expect(tree.orphanTasks.map((x) => x.id)).toContain(id);
	});

	it("task-update changes only the fields passed; effort lands in the raw event", async () => {
		const id = run("task-add.sh", ["--title", "x", "--id", "TASK-fixed"]);
		run("task-update.sh", [
			"--id",
			id,
			"--status",
			"in-progress",
			"--effort",
			"3",
			"--note",
			"started",
		]);
		run("task-update.sh", ["--id", id, "--status", "completed"]);

		const tree = await loadObjectivesStore(shared);
		const t = tree.tasks.find((x) => x.id === "TASK-fixed");
		expect(t?.status).toBe("completed");
		expect(t?.title).toBe("x"); // untouched by updates
		expect(t?.notes).toEqual(["started"]);
	});

	it("rejects an invalid task status (contract enforced script-side)", () => {
		const id = run("task-add.sh", ["--title", "x"]);
		expect(() =>
			run("task-update.sh", ["--id", id, "--status", "bogus"]),
		).toThrow();
	});

	it("record-kpi stores numeric values as numbers and text as text", async () => {
		// authored goals.json so the KPI defs exist to receive values
		mkdirSync(join(shared, "objectives"), { recursive: true });
		writeFileSync(
			join(shared, "objectives", "goals.json"),
			JSON.stringify({
				objectives: [
					{
						id: "OBJ-1",
						parent: null,
						title: "root",
						owner: "lead",
						status: "active",
						kpis: [
							{
								id: "K-num",
								label: "records",
								owner: AGENT,
								kind: "quantitative",
								source: "agent-reported",
							},
							{
								id: "K-txt",
								label: "coverage",
								owner: AGENT,
								kind: "qualitative",
								source: "agent-reported",
							},
						],
					},
				],
			}),
		);
		run("record-kpi.sh", [
			"--kpi",
			"K-num",
			"--value",
			"38",
			"--note",
			"so far",
		]);
		run("record-kpi.sh", ["--kpi", "K-txt", "--value", "met"]);

		const tree = await loadObjectivesStore(shared);
		const kpis = tree.objectives[0].kpis;
		expect(kpis.find((k) => k.id === "K-num")?.value).toBe(38);
		expect(kpis.find((k) => k.id === "K-txt")?.value).toBe("met");
		expect(kpis.find((k) => k.id === "K-txt")?.stale).toBe(false);
	});

	it("allocate appends an allocation intent the attribution reads", async () => {
		const out = run("allocate.sh", ["--key", "TASK-1:60,overhead:40"]);
		expect(out).toContain("recorded");
		const { loadAllocEvents } = await import("../src/objectives/store.js");
		const events = await loadAllocEvents(shared);
		expect(events).toHaveLength(1);
		expect(events[0].by).toBe(AGENT);
		expect(events[0].key).toEqual({ "TASK-1": 60, overhead: 40 });
	});

	it("allocate rejects a malformed key", () => {
		expect(() => run("allocate.sh", ["--key", "bogus"])).toThrow();
	});

	it("makes no git calls (no .git is created)", () => {
		run("task-add.sh", ["--title", "x"]);
		run("record-kpi.sh", ["--kpi", "K1", "--value", "1"]);
		expect(existsSync(join(shared, ".git"))).toBe(false);
		expect(existsSync(join(shared, "objectives", ".git"))).toBe(false);
	});
});
