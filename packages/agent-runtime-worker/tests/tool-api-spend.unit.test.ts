/**
 * Background jobs' LLM calls through the Tool API are charged and gated like
 * an agent's own (CST-1, sprint-28f audit): metered into llmCallLog, charged
 * to the job's agent's lifetime cost, followed by the mission-cap check, and
 * refused while the cap has the mission paused. No LLM, no Mongo.
 */

import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createJobSpend } from "../src/daemon-boot/monitor-tool-servers.js";
import { CLAUDE_HAIKU, CLAUDE_SONNET } from "../src/models.js";
import { jobSubAgentHooks, ToolApiServer } from "../src/tool-api-server.js";

type SpendCtx = Parameters<typeof createJobSpend>[0];

function spendCtx(opts: { spentUsd: number; capUsd: number }) {
	const append = vi.fn(async () => {});
	const recordOutOfTurnCost = vi.fn(async () => {});
	const notifyCostPause = vi.fn(async () => {});
	const conversationAppend = vi.fn(async () => {});
	const ctx = {
		conversationRepo: { append: conversationAppend },
		missionId: "m1",
		model: CLAUDE_SONNET,
		llmCallLog: { append },
		statsCollector: {
			recordOutOfTurnCost,
			readMissionSnapshot: async () => [
				{ agentId: "a1", lifetimeCostUsd: opts.spentUsd, turnCostUsd: 0 },
			],
		},
		missionConfigRepo: {
			readTeamConfig: async () => ({ mission: { maxCostUsd: opts.capUsd } }),
		},
		maxCostUsd: null,
		monitor: { notifyCostPause, isBudgetPaused: () => false },
		anomalyRecorder: { record: async () => {} },
		mailboxRepo: { post: async () => {} },
	} as unknown as SpendCtx;
	return {
		ctx,
		append,
		recordOutOfTurnCost,
		notifyCostPause,
		conversationAppend,
	};
}

const event = {
	systemPrompt: "s",
	messages: [],
	toolNames: [],
	model: CLAUDE_HAIKU,
	response: {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		stopReason: "stop",
		usage: { input: 10_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
	},
} as never;

describe("createJobSpend", () => {
	it("logs a job's call under its agent, charges that agent's lifetime cost, and checks the cap", async () => {
		const s = spendCtx({ spentUsd: 6, capUsd: 5 });
		const meter = createJobSpend(s.ctx).meterFor("a1");
		await meter(event);
		expect(s.append).toHaveBeenCalledWith(
			expect.objectContaining({ missionId: "m1", agentId: "a1" }),
		);
		expect(s.recordOutOfTurnCost).toHaveBeenCalledWith(
			"m1",
			"a1",
			expect.any(Number),
			"background job",
		);
		const charged = (s.recordOutOfTurnCost.mock.calls[0] as unknown[])[2];
		expect(charged).toBeGreaterThan(0);
		expect(s.notifyCostPause).toHaveBeenCalledWith(6, 5);
	});

	it("llm-call.recorded: logs and charges a sub-agent's call, which names no model, at the loop model's price", async () => {
		const s = spendCtx({ spentUsd: 1, capUsd: 5 });
		const { model: _named, ...subLoopEvent } = event as { model: unknown };
		await createJobSpend(s.ctx).meterFor("a1")(subLoopEvent as never);
		expect(s.append).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "a1", model: CLAUDE_SONNET.id }),
		);
		const charged = (s.recordOutOfTurnCost.mock.calls[0] as unknown[])[2];
		expect(charged).toBeGreaterThan(0);
	});

	it("turn.persisted-per-step: stores a job's sub-agent step under its agent and job, outside any turn", async () => {
		const s = spendCtx({ spentUsd: 1, capUsd: 5 });
		const msg = { role: "user", content: "task", timestamp: 1 } as const;
		await jobSubAgentHooks(
			createJobSpend(s.ctx),
			"a1",
			"job-7",
			CLAUDE_SONNET,
		).onMessage("call-3", msg);
		expect(s.conversationAppend).toHaveBeenCalledWith("a1", "m1", [
			{
				turnNumber: 0,
				parentToolUseId: "call-3",
				jobId: "job-7",
				message: msg,
			},
		]);
	});

	it("llm-call.cost-counted: a job's sub-agent is charged to its agent, and stopped by the cap's pause", async () => {
		const s = spendCtx({ spentUsd: 1, capUsd: 5 });
		let paused = false;
		const spend = { ...createJobSpend(s.ctx), isBudgetPaused: () => paused };
		const hooks = jobSubAgentHooks(spend, "a1", "job-7", CLAUDE_SONNET);
		await hooks.beforeLlmCall();
		const { model: _named, ...subLoopEvent } = event as { model: unknown };
		await hooks.onLlmCall(subLoopEvent as never);
		expect(hooks.costOf(subLoopEvent as never)).toBeGreaterThan(0);
		expect(s.recordOutOfTurnCost).toHaveBeenCalledWith(
			"m1",
			"a1",
			expect.any(Number),
			"background job",
		);
		paused = true;
		await expect(hooks.beforeLlmCall()).rejects.toThrow(/spend cap/);
	});

	it("does not pause below the cap", async () => {
		const s = spendCtx({ spentUsd: 1, capUsd: 5 });
		await createJobSpend(s.ctx).meterFor("a1")(event);
		expect(s.notifyCostPause).not.toHaveBeenCalled();
	});
});

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

describe("ToolApiServer while the mission is budget-paused", () => {
	it("refuses LLM-backed tools with 503 and still serves the others", async () => {
		const server = new ToolApiServer(
			CLAUDE_SONNET,
			CLAUDE_HAIKU,
			"/tmp/magi-tool-api-spend",
			{ post: async () => {} } as never,
			{ mission: { id: "m1", name: "t" }, agents: [{ id: "a1" }] } as never,
			{
				meterFor: () => async () => {},
				isBudgetPaused: () => true,
				recordStep: async () => {},
			},
		);
		const port = await freePort();
		server.listen(port);
		await new Promise((r) => setTimeout(r, 50));
		try {
			const token = server.issueToken(
				{ agentId: "a1", linuxUser: "magi-w1", permittedPaths: ["/tmp"] },
				{ workdir: "/tmp", sharedDir: "/tmp", linuxUser: "magi-w1" },
				"job-1",
			);
			const call = (tool: string, body: unknown) =>
				fetch(`http://127.0.0.1:${port}/tools/${tool}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				});
			for (const tool of ["research", "fetch-url", "inspect-image"]) {
				const r = await call(tool, { question: "q" });
				expect(r.status).toBe(503);
				expect(((await r.json()) as { error: string }).error).toMatch(
					/spend cap/,
				);
			}
			const other = await call("post-message", {});
			expect(other.status).not.toBe(503);
		} finally {
			server.stop();
		}
	});
});
