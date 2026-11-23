/**
 * Why a machine stopped, from Fly (fly-machine-diagnostics.ts), and the
 * copilot's ReadMissionLog falling back to Fly's log when the daemon is down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	describeLastExit,
	fetchMachineLog,
	isCrashStopped,
	lastExit,
} from "../src/fly-machine-diagnostics.js";
import type { FlyMachineEvent } from "../src/fly-machines.js";

const exit = (
	timestamp: number,
	e: NonNullable<NonNullable<FlyMachineEvent["request"]>["exit_event"]>,
): FlyMachineEvent => ({ type: "exit", timestamp, request: { exit_event: e } });

// AI News Digest's machine, 2026-11-23: three restarts, each exit code 1.
const crashLoop: FlyMachineEvent[] = [
	exit(1795405001263, {
		exit_code: 1,
		oom_killed: false,
		requested_stop: false,
		exited_at: "2026-11-23T03:36:41Z",
	}),
	{ type: "start", timestamp: 1795405002261 },
	exit(1795405010578, {
		exit_code: 1,
		oom_killed: false,
		requested_stop: false,
		exited_at: "2026-11-23T03:36:50Z",
	}),
];

describe("machine exit diagnosis", () => {
	it("takes the latest exit, whatever the order of the events", () => {
		expect(lastExit([...crashLoop].reverse())?.exitedAt).toBe(
			"2026-11-23T03:36:50Z",
		);
		expect(lastExit([{ type: "start" }])).toBeNull();
	});

	it("names a crash at boot for what it is, not an out-of-memory kill", () => {
		const machine = { state: "stopped", events: crashLoop };
		expect(isCrashStopped(machine)).toBe(true);
		const line = describeLastExit(machine);
		expect(line).toContain(
			"exit code 1, not an out-of-memory kill, not a requested stop",
		);
		expect(line).toContain("Fly's restarts are used up");
	});

	it("an OOM kill is a crash; a requested stop or a clean exit is not", () => {
		const one = (e: Parameters<typeof exit>[1]) => ({
			state: "stopped",
			events: [exit(1, e)],
		});
		expect(isCrashStopped(one({ exit_code: 137, oom_killed: true }))).toBe(
			true,
		);
		expect(isCrashStopped(one({ exit_code: 1, requested_stop: true }))).toBe(
			false,
		);
		expect(isCrashStopped(one({ exit_code: 0 }))).toBe(false);
		expect(isCrashStopped({ state: "started", events: crashLoop })).toBe(false);
	});
});

describe("fetchMachineLog", () => {
	const env = { ...process.env };
	beforeEach(() => {
		process.env.FLY_MISSIONS_APP_NAME = "magi-missions-test";
		process.env.FLY_API_TOKEN_MACHINES = "FlyV1 fm2_secret";
	});
	afterEach(() => {
		process.env = { ...env };
	});

	it("asks Fly's fixed logs host for this machine, with the token as Fly issued it", async () => {
		const fetchFn = vi.fn(async () =>
			Response.json({
				data: [
					{
						attributes: {
							timestamp: "t1",
							message: "[daemon] Already running as PID 618",
						},
					},
					{ attributes: { timestamp: 2, message: { not: "text" } } },
				],
			}),
		);
		const lines = await fetchMachineLog(
			"82dd/../x",
			fetchFn as unknown as typeof fetch,
		);
		const [url, init] = fetchFn.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe(
			"https://api.fly.io/api/v1/apps/magi-missions-test/logs?instance=82dd%2F..%2Fx&next_token=",
		);
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"FlyV1 fm2_secret",
		);
		expect(lines).toEqual([
			{ timestamp: "t1", message: "[daemon] Already running as PID 618" },
			{ timestamp: "", message: "" },
		]);
	});

	it("says Fly refused, with the status", async () => {
		const fetchFn = async () => new Response("no", { status: 401 });
		await expect(fetchMachineLog("m", fetchFn as typeof fetch)).rejects.toThrow(
			"401",
		);
	});
});
