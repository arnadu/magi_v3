/**
 * The platform-task runner (mission.platform-task): what runs, when nothing runs, overlap, and
 * when the operator is told. The run itself is injected; the wrapper is tested in the sandbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FAILURES_BEFORE_ANOMALY,
	startPlatformTasks,
	type TaskOutcome,
	taskArgs,
} from "../src/platform-tasks.js";

const TASK = {
	kind: "git-mirror",
	name: "magi-v3",
	params: { url: "https://github.com/arnadu/magi_v3", branch: "main" },
};

function setup(over: Partial<Parameters<typeof startPlatformTasks>[0]> = {}) {
	const anomalies: string[] = [];
	const logs: string[] = [];
	const runs: string[] = [];
	const runner = startPlatformTasks({
		missionId: "m1",
		rawTasks: [TASK],
		anomalies: {
			record: async (a) => {
				anomalies.push(`${a.category}: ${a.message}`);
			},
		},
		onFly: true,
		wrapperExists: () => true,
		run: async (t) => {
			runs.push(t.name);
			return { ok: true, output: "abc123" };
		},
		log: (l) => logs.push(l),
		...over,
	});
	return { runner, anomalies, logs, runs };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startPlatformTasks", () => {
	it("passes the wrapper fixed arguments per kind", () => {
		expect(taskArgs({ ...TASK, kind: "git-mirror", everyMinutes: 15 })).toEqual(
			["git-mirror", "magi-v3", "https://github.com/arnadu/magi_v3", "main"],
		);
	});

	it("runs each task at start and then every everyMinutes", async () => {
		const { runner, runs } = setup({
			rawTasks: [{ ...TASK, everyMinutes: 5 }],
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(runs).toEqual(["magi-v3"]);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(runs).toEqual(["magi-v3", "magi-v3"]);
		runner.stop();
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(runs).toHaveLength(2);
	});

	it("runs nothing, and tells the operator on Fly, when the task list is invalid", async () => {
		const { runner, anomalies, runs } = setup({
			rawTasks: [{ ...TASK, kind: "shell" }],
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(runs).toEqual([]);
		expect(runner.tasks).toEqual([]);
		expect(anomalies[0]).toMatch(/^platform-task-failure: .*invalid/);
	});

	it("runs nothing without the wrapper: an anomaly on Fly, a log line elsewhere", async () => {
		const fly = setup({ wrapperExists: () => false });
		const local = setup({ wrapperExists: () => false, onFly: false });
		await vi.advanceTimersByTimeAsync(0);
		expect(fly.runs).toEqual([]);
		expect(fly.anomalies[0]).toMatch(/not installed/);
		expect(local.anomalies).toEqual([]);
		expect(local.logs[0]).toMatch(/not installed.*outside the mission image/);
	});

	it("never starts a task twice at once", async () => {
		let release: (o: TaskOutcome) => void = () => {};
		const { runner } = setup({
			run: () =>
				new Promise((r) => {
					release = r;
				}),
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(await runner.runNow("magi-v3")).toBe("busy");
		release({ ok: true, output: "x" });
		await vi.advanceTimersByTimeAsync(0);
		expect(await runner.runNow("nope")).toBe("unknown");
		runner.stop();
	});

	it("tells the operator once per streak of failures, and a success ends the streak", async () => {
		let ok = false;
		const { runner, anomalies } = setup({
			run: async () =>
				ok ? { ok: true, output: "c" } : { ok: false, error: "fetch failed" },
		});
		await vi.advanceTimersByTimeAsync(0);
		for (let i = 1; i < FAILURES_BEFORE_ANOMALY + 2; i++)
			await runner.runNow("magi-v3");
		expect(anomalies).toHaveLength(1);
		expect(anomalies[0]).toMatch(/failed 3 times in a row.*fetch failed/);
		ok = true;
		await runner.runNow("magi-v3");
		ok = false;
		for (let i = 0; i < FAILURES_BEFORE_ANOMALY; i++)
			await runner.runNow("magi-v3");
		expect(anomalies).toHaveLength(2);
		runner.stop();
	});
});
