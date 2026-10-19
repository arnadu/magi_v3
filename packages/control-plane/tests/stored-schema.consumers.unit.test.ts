/**
 * Stored-schema contract (R-15): documents written by the real writers are
 * read back by every consumer that has a separate implementation, and arrive
 * with their values — not zeros, nulls or blanks. Each block exists because a
 * reader once looked for a field the writer never wrote (`cost.total`, $0
 * mission spend in #53, a single-recipient PostMessage missing from stats).
 *
 * The types catch a wrong field name at compile time; this catches a reader
 * that compiles but queries a different collection, filter or unit.
 */
import {
	createMongoAgentStatsRepository,
	createMongoLlmCallLogRepository,
	StatsCollector,
} from "@magi/agent-runtime-worker";
import { describe, expect, it } from "vitest";
import { createScheduleTools } from "../../agent-runtime-worker/src/mission-copilot-schedule-tools.js";
import { executeCreateSchedule } from "../src/copilot-schedule-actions.js";
import { readCopilotSpend } from "../src/copilot-spend.js";
import { postMailbox } from "../src/mailbox-writer.js";
import { summarizeMissions } from "../src/mission-stats-summary.js";
import {
	queryLlmCall,
	queryLlmCalls,
	queryTurns,
} from "../src/transcript-queries.js";
import { lifetimeCostByMission, lifetimeUsage } from "../src/usage-queries.js";
import { fakeDb } from "./support/fake-db.js";

const MISSION = "m-contract";

async function runOneTurn(
	db: ReturnType<typeof fakeDb>["db"],
	missionId: string,
	agentId: string,
): Promise<void> {
	const stats = new StatsCollector(createMongoAgentStatsRepository(db));
	await stats.startTurn(missionId, agentId, 1, false);
	await stats.recordLlmCall(agentId, {
		inputTokens: 1000,
		outputTokens: 200,
		cacheReadTokens: 50,
		cacheWriteTokens: 0,
		costUsd: 0.25,
	});
	await stats.endTurn(agentId);
}

describe("agentTurnStats / missionStats: StatsCollector → readers", () => {
	it("the mission summary, usage totals and transcript turns see the turn's cost", async () => {
		const { db } = fakeDb();
		await runOneTurn(db, MISSION, "lead");

		const summary = (await summarizeMissions(db, [MISSION]))[MISSION];
		expect(summary.spendTotal).toBeCloseTo(0.25);
		expect(summary.spendToday).toBeCloseTo(0.25);
		expect(summary.lastActivity).toBeInstanceOf(Date);

		expect(await lifetimeUsage(db, MISSION)).toEqual({
			calls: 1,
			inputTokens: 1000,
			outputTokens: 200,
			cacheReadTokens: 50,
			costUsd: 0.25,
		});
		expect((await lifetimeCostByMission(db, [MISSION])).get(MISSION)).toEqual({
			totalCostUsd: 0.25,
			calls: 1,
		});

		const [turn] = await queryTurns(db, MISSION, "lead");
		expect(turn).toMatchObject({
			turnNumber: 1,
			status: "complete",
			llmCallCount: 1,
			costUsd: 0.25,
		});
	});

	it("the copilot spend cap reads the copilot's lifetime spend", async () => {
		const { db } = fakeDb();
		await runOneTurn(db, "copilot-u1", "copilot");
		expect(await readCopilotSpend(db, "copilot-u1")).toBeCloseTo(0.25);
	});
});

describe("llmCallLog: repository → transcript queries", () => {
	it("usage and cost survive the flattening for the cockpit", async () => {
		const { db } = fakeDb();
		await createMongoLlmCallLogRepository(db).append({
			missionId: MISSION,
			agentId: "lead",
			turnNumber: 3,
			isReflection: false,
			savedAt: new Date("2026-10-19T10:00:00Z"),
			model: "claude-sonnet-4-6",
			callId: "call-1",
			usage: {
				inputTokens: 1000,
				outputTokens: 200,
				cacheReadTokens: 50,
				cacheWriteTokens: 10,
				cost: {
					inputCostUsd: 0.003,
					outputCostUsd: 0.003,
					cacheReadCostUsd: 0.0001,
					cacheWriteCostUsd: 0.0001,
					totalCostUsd: 0.0062,
				},
			},
		});
		const [call] = await queryLlmCalls(db, MISSION, "lead", 3);
		expect(call).toMatchObject({
			callId: "call-1",
			model: "claude-sonnet-4-6",
			usage: {
				inputTokens: 1000,
				outputTokens: 200,
				cacheReadTokens: 50,
				cacheWriteTokens: 10,
			},
			costUsd: 0.0062,
		});
		expect(await queryLlmCall(db, MISSION, "lead", 3, 0)).toMatchObject({
			costUsd: 0.0062,
		});
	});
});

describe("mailbox: postMailbox → mission summary", () => {
	it("mail to the operator is unread and becomes the snippet", async () => {
		const { db } = fakeDb();
		await postMailbox(db, {
			missionId: MISSION,
			from: "lead",
			to: ["user"],
			subject: "Daily brief ready",
			body: "…",
		});
		const summary = (await summarizeMissions(db, [MISSION]))[MISSION];
		expect(summary.unread).toBe(1);
		expect(summary.snippet).toContain("Daily brief ready");
	});
});

describe("scheduled_messages: control-plane create_schedule → mission copilot listing", () => {
	it("the mission copilot sees the recipients, subject and next fire time", async () => {
		const { db } = fakeDb({
			missions: [
				{
					missionId: MISSION,
					userId: "u1",
					agents: [{ id: "lead" }],
				},
			],
		});
		await executeCreateSchedule(
			db,
			{
				missionId: MISSION,
				to: ["lead"],
				subject: "Weekly review",
				body: "Review the week.",
				deliverAt: "2026-10-20T09:00:00Z",
			},
			"u1",
			new Date("2026-10-19T00:00:00Z"),
		);
		const { listScheduledMessages } = createScheduleTools({
			db,
			missionId: MISSION,
			sharedDir: "/nonexistent",
			auditPost: async () => {},
		});
		const out = await listScheduledMessages.execute("t1", {});
		const rows = JSON.parse(
			(out.content[0] as { type: "text"; text: string }).text,
		) as Array<{ to: string[]; subject: string; deliverAt: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ to: ["lead"], subject: "Weekly review" });
		expect(new Date(rows[0].deliverAt).toISOString()).toBe(
			"2026-10-20T09:00:00.000Z",
		);
	});
});
