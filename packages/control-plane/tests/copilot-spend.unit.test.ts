/** The copilot spend cap: lifetime missionStats spend against the user's cap. */
import { describe, expect, it } from "vitest";
import {
	checkCopilotSpendCap,
	readCopilotSpend,
} from "../src/copilot-spend.js";
import { fakeDb } from "./support/fake-db.js";

const stats = (costUsd: number) => ({
	missionId: "copilot-u1",
	agentId: "copilot",
	lifetimeCostUsd: costUsd,
	lifetimeLlmCallCount: 1,
	lifetimeTurnCount: 1,
	consecutiveZeroOutputTurns: 0,
	lastTurnAt: new Date(),
});

describe("copilot spend cap", () => {
	it("no cap set: never refuses", async () => {
		const { db } = fakeDb({
			users: [{ uid: "u1" }],
			missionStats: [stats(99)],
		});
		expect(await checkCopilotSpendCap(db, "u1")).toBeNull();
	});

	it("under the cap: allowed", async () => {
		const { db } = fakeDb({
			users: [{ uid: "u1", copilotSpendCapUsd: 5 }],
			missionStats: [stats(4.99)],
		});
		expect(await checkCopilotSpendCap(db, "u1")).toBeNull();
	});

	it("at or over the cap: refused with spent and cap", async () => {
		const { db } = fakeDb({
			users: [{ uid: "u1", copilotSpendCapUsd: 5 }],
			missionStats: [stats(5)],
		});
		expect(await checkCopilotSpendCap(db, "u1")).toBe(
			"Copilot spend cap reached ($5.00 / $5.00). Raise the cap in Limits to continue.",
		);
	});

	it("a copilot that never ran has spent nothing", async () => {
		const { db } = fakeDb({ missionStats: [] });
		expect(await readCopilotSpend(db, "copilot-u2")).toBe(0);
	});
});
