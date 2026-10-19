/**
 * Characterization tests for runAgent's turn handling, written before
 * decomposing it (code-quality plan, step 2). The LLM loop is mocked; the
 * tools, mailbox tool, mental map and prompt code are real. They pin what a
 * turn does around the loop: tool filtering, the supervisor fallback, how a
 * hard limit and a crash finalize the turn, and the conversation-recovery
 * retry.
 */
import type { TeamConfig } from "@magi/agent-config";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loopCalls: Array<Record<string, unknown>> = [];
let loopImpl: (cfg: Record<string, unknown>) => Promise<unknown> =
	async () => ({
		messages: [],
		turnCount: 0,
	});

vi.mock("../src/loop.js", () => ({
	runInnerLoop: vi.fn(async (cfg: Record<string, unknown>) => {
		loopCalls.push(cfg);
		return loopImpl(cfg);
	}),
}));
vi.mock("../src/tools/browse-web.js", () => ({
	tryCreateBrowseWebTool: () => null,
}));
vi.mock("../src/tools/search-web.js", () => ({
	tryCreateSearchWebTool: () => null,
}));

const { runAgent } = await import("../src/agent-runner.js");
const { LimitExceededError } = await import("../src/limits.js");

type Tool = {
	name: string;
	execute: (id: string, args: unknown) => Promise<unknown>;
};

function assistant(
	text: string,
	extra: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
		...extra,
	} as AssistantMessage;
}

function harness(
	opts: {
		agent?: Record<string, unknown>;
		history?: Array<{ turnNumber: number; message: Message }>;
		additionalTools?: Tool[];
	} = {},
) {
	const appended: Array<Record<string, unknown>> = [];
	const posts: Array<{ to: string[]; subject: string; body: string }> = [];
	const endTurns: string[] = [];
	const compacts: number[] = [];
	let history = opts.history ?? [];
	const teamConfig = {
		mission: { id: "m1", name: "M" },
		agents: [
			{
				id: "a1",
				role: "worker",
				systemPrompt: "You work.",
				initialMentalMap: "<h1>Map</h1>",
				...opts.agent,
			},
		],
	} as unknown as TeamConfig;
	const ctx = {
		model: { id: "test-model", contextWindow: 200_000 },
		teamConfig,
		identity: { workdir: "/tmp/w", sharedDir: "/tmp/s", linuxUser: "magi-w1" },
		conversationRepo: {
			load: async () => history,
			loadMostRecentMentalMap: async () => null,
			append: async (
				_a: string,
				_m: string,
				docs: Array<Record<string, unknown>>,
			) => {
				appended.push(...docs);
			},
			compact: async (_a: string, _m: string, keepFrom: number) => {
				compacts.push(keepFrom);
				history = [];
			},
		},
		mailboxRepo: {
			post: async (msg: { to: string[]; subject: string; body: string }) => {
				posts.push(msg);
				return { ...msg, id: "x", timestamp: new Date(), readBy: [] };
			},
		},
		statsCollector: {
			startTurn: async () => {},
			endTurn: async (_agent: string, status: string) => {
				endTurns.push(status);
			},
			getTurn: () => undefined,
			readLifetime: async () => null,
			recordToolResult: async () => {},
			recordLlmCall: async () => {},
		},
		additionalTools: opts.additionalTools,
	};
	return { ctx, appended, posts, endTurns, compacts };
}

const fromSupervisor = [
	{
		id: "mm1",
		missionId: "m1",
		from: "user",
		to: ["a1"],
		subject: "Do it",
		body: "Please do it.",
		timestamp: new Date(),
		readBy: [],
	},
];

beforeEach(() => {
	loopCalls.length = 0;
	loopImpl = async () => ({ messages: [], turnCount: 0 });
});

describe("runAgent tools", () => {
	it("drops disabled tools and appends additional tools unfiltered", async () => {
		const extra: Tool = { name: "ExtraTool", execute: async () => ({}) };
		const h = harness({
			agent: { disabledTools: ["FetchUrl", "ExtraTool"] },
			additionalTools: [extra],
		});
		await runAgent("a1", [], h.ctx as never);
		const names = (loopCalls[0].tools as Tool[]).map((t) => t.name);
		expect(names).not.toContain("FetchUrl");
		expect(names).toContain("ExtraTool");
		expect(names).toContain("PostMessage");
	});
});

describe("runAgent supervisor fallback", () => {
	it("replies to the supervisor with the last text when the agent never posted", async () => {
		const h = harness();
		loopImpl = async (cfg) => {
			const msg = assistant("All done.");
			await (cfg.onMessage as (m: Message, all: Message[]) => Promise<void>)(
				msg,
				[msg],
			);
			return { messages: [msg], turnCount: 1 };
		};
		await runAgent("a1", fromSupervisor, h.ctx as never);
		expect(h.posts).toEqual([
			expect.objectContaining({
				to: ["user"],
				subject: "Re: Do it",
				body: "All done.",
			}),
		]);
	});

	it("does not reply when the agent posted to its supervisor itself", async () => {
		const h = harness();
		loopImpl = async (cfg) => {
			const post = (cfg.tools as Tool[]).find((t) => t.name === "PostMessage");
			await post?.execute("t1", {
				to: ["user"],
				subject: "Report",
				body: "Here.",
			});
			return { messages: [assistant("Sent.")], turnCount: 2 };
		};
		await runAgent("a1", fromSupervisor, h.ctx as never);
		expect(h.posts.map((p) => p.subject)).toEqual(["Report"]);
	});

	it("does not reply to a message that did not come from the supervisor", async () => {
		const h = harness();
		loopImpl = async () => ({ messages: [assistant("ok")], turnCount: 1 });
		await runAgent(
			"a1",
			[{ ...fromSupervisor[0], from: "peer" }],
			h.ctx as never,
		);
		expect(h.posts).toEqual([]);
	});
});

describe("runAgent turn finalization", () => {
	it("a hard limit ends the turn as aborted without throwing", async () => {
		const h = harness();
		loopImpl = async () => {
			throw new LimitExceededError({
				rule: {
					id: "r",
					metric: "turnCostUsd",
					threshold: 1,
					label: "cost",
					severity: "hard",
				},
				value: 2,
			} as never);
		};
		await expect(runAgent("a1", [], h.ctx as never)).resolves.toBeUndefined();
		expect(h.endTurns).toEqual(["aborted"]);
	});

	it("any other error still finalizes the turn, then propagates", async () => {
		const h = harness();
		loopImpl = async () => {
			throw new Error("boom");
		};
		await expect(runAgent("a1", [], h.ctx as never)).rejects.toThrow("boom");
		expect(h.endTurns).toEqual(["complete"]);
	});

	it("a last call cut short by the loop's own deadline counts as aborted", async () => {
		const h = harness();
		loopImpl = async () => ({
			messages: [assistant("", { stopReason: "aborted" })],
			turnCount: 1,
		});
		await runAgent("a1", [], h.ctx as never);
		expect(h.endTurns).toEqual(["aborted"]);
	});
});

describe("runAgent conversation recovery", () => {
	const structureError = assistant("", {
		stopReason: "error",
		errorMessage:
			"messages.3.content.0: unexpected `tool_use_id` found in tool_result",
	});

	it("compacts the history and retries once on a structure error at the first call", async () => {
		const h = harness({
			history: [
				{
					turnNumber: 4,
					message: {
						role: "user",
						content: "earlier",
						timestamp: 0,
					} as Message,
				},
			],
		});
		loopImpl = async (cfg) => {
			if (loopCalls.length === 1)
				return { messages: [structureError], turnCount: 1 };
			const msg = assistant("Recovered.");
			await (cfg.onMessage as (m: Message, all: Message[]) => Promise<void>)(
				msg,
				[msg],
			);
			return { messages: [msg], turnCount: 1 };
		};
		await runAgent("a1", [], h.ctx as never);
		expect(loopCalls).toHaveLength(2);
		expect(h.compacts).toEqual([6]);
		// The retry's first assistant message starts the call sequence again.
		expect(h.appended.at(-1)).toMatchObject({ callSeq: 0 });
	});

	it("finalizes from the retry's outcome, not the failed first attempt", async () => {
		const h = harness({
			history: [
				{
					turnNumber: 2,
					message: { role: "user", content: "x", timestamp: 0 } as Message,
				},
			],
		});
		loopImpl = async () => {
			if (loopCalls.length === 1)
				return { messages: [structureError], turnCount: 1 };
			return {
				messages: [assistant("", { stopReason: "aborted" })],
				turnCount: 1,
			};
		};
		await runAgent("a1", [], h.ctx as never);
		expect(h.endTurns).toEqual(["aborted"]);
	});

	it("the supervisor fallback reports the retry's error, not the first attempt's", async () => {
		const h = harness({
			history: [
				{
					turnNumber: 2,
					message: { role: "user", content: "x", timestamp: 0 } as Message,
				},
			],
		});
		loopImpl = async () => {
			if (loopCalls.length === 1)
				return { messages: [structureError], turnCount: 1 };
			return {
				messages: [
					assistant("", { stopReason: "error", errorMessage: "overloaded" }),
				],
				turnCount: 1,
			};
		};
		await runAgent("a1", fromSupervisor, h.ctx as never);
		expect(h.posts[0].body).toContain("overloaded");
	});

	it("does not retry on the agent's very first turn", async () => {
		const h = harness();
		loopImpl = async () => ({ messages: [structureError], turnCount: 1 });
		await runAgent("a1", [], h.ctx as never);
		expect(loopCalls).toHaveLength(1);
		expect(h.compacts).toEqual([]);
	});

	it("does not retry when tools already ran (the error came from this session)", async () => {
		const h = harness({
			history: [
				{
					turnNumber: 0,
					message: { role: "user", content: "x", timestamp: 0 } as Message,
				},
			],
		});
		loopImpl = async () => ({ messages: [structureError], turnCount: 2 });
		await runAgent("a1", [], h.ctx as never);
		expect(loopCalls).toHaveLength(1);
	});
});
