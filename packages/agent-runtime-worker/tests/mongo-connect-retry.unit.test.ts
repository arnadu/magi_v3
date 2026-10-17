import { describe, expect, it } from "vitest";
import { connectWithRetry } from "../src/mongo.js";

/** Fake clock + sleep: each sleep advances the clock, nothing really waits. */
function clock() {
	let t = 0;
	const slept: number[] = [];
	return {
		now: () => t,
		sleep: async (ms: number) => {
			slept.push(ms);
			t += ms;
		},
		slept,
	};
}

describe("connectWithRetry", () => {
	it("returns the first successful connection after transient failures, backing off 2 s → 4 s", async () => {
		const c = clock();
		const lines: string[] = [];
		let calls = 0;
		const result = await connectWithRetry(
			async () => {
				calls++;
				if (calls < 3) throw new Error("querySrv ENOTFOUND _mongodb._tcp.x");
				return "db";
			},
			{ now: c.now, sleep: c.sleep, log: (l) => lines.push(l) },
		);
		expect(result).toBe("db");
		expect(calls).toBe(3);
		expect(c.slept).toEqual([2_000, 4_000]);
		expect(lines[0]).toMatch(/attempt 1.*ENOTFOUND.*retrying in 2 s/);
	});

	it("caps the delay and gives up with the last error once the budget is spent", async () => {
		const c = clock();
		const lines: string[] = [];
		let calls = 0;
		await expect(
			connectWithRetry(
				async () => {
					calls++;
					throw new Error(`down ${calls}`);
				},
				{
					now: c.now,
					sleep: c.sleep,
					log: (l) => lines.push(l),
					maxWaitMs: 70_000,
					maxDelayMs: 30_000,
				},
			),
		).rejects.toThrow(/down \d+/);
		// 2 + 4 + 8 + 16 + 30 = 60 s spent; the next 30 s would exceed 70 s.
		expect(c.slept).toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
		expect(calls).toBe(6);
		expect(lines.at(-1)).toMatch(/giving up/);
	});

	it("does not retry a connect that succeeds immediately", async () => {
		const c = clock();
		await expect(
			connectWithRetry(async () => 1, { now: c.now, sleep: c.sleep }),
		).resolves.toBe(1);
		expect(c.slept).toEqual([]);
	});
});
