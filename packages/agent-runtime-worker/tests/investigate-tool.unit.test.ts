/**
 * Investigate (agent.investigate): what the sub-agent is given, and what counts as an answer.
 * The model and the shell are scripted; the sub-loop is the real inner loop.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAUDE_SONNET } from "../src/models.js";
import {
	createInvestigateTool,
	extractJson,
} from "../src/tools/investigate.js";
import type { MagiTool } from "../src/tools.js";

const COMMIT = "a".repeat(40);
const SCHEMA = {
	type: "object",
	required: ["verdict", "evidence"],
	properties: {
		verdict: { enum: ["real", "false-positive", "unknown"] },
		evidence: { type: "array", items: { type: "string" } },
	},
	additionalProperties: false,
};

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "x",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	} as AssistantMessage;
}

let root: string;
let workdir: string;
let outside: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "investigate-"));
	workdir = join(root, "work");
	outside = join(root, "outside");
	mkdirSync(workdir);
	mkdirSync(outside);
	writeFileSync(join(workdir, "SKILL.md"), "Check whether the alert is real.");
	writeFileSync(join(outside, "SKILL.md"), "secret");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(
	replies: (string | AssistantMessage)[],
	statusText = JSON.stringify({ commit: COMMIT }),
) {
	const contexts: Context[] = [];
	const shellCalls: string[] = [];
	const shell: MagiTool = {
		name: "Bash",
		operation: "agent.shell",
		description: "",
		parameters: Type.Object({ command: Type.String() }),
		async execute(_id, args) {
			const cmd = (args as { command: string }).command;
			shellCalls.push(cmd);
			if (cmd.includes("status.json"))
				return { content: [{ type: "text", text: statusText }] };
			return { content: [{ type: "text", text: "" }] };
		},
	};
	let i = 0;
	const tool = createInvestigateTool(
		CLAUDE_SONNET,
		{ agentId: "appsec", permittedPaths: [workdir], linuxUser: "appsec" },
		{
			workdir,
			shell,
			completeFn: async (_m, ctx) => {
				contexts.push(structuredClone(ctx));
				const next = replies[Math.min(i++, replies.length - 1)];
				return typeof next === "string" ? reply(next) : next;
			},
		},
	);
	return { tool, contexts, shellCalls };
}

const ok = '```json\n{"verdict":"false-positive","evidence":["a.ts:3"]}\n```';

describe("Investigate", () => {
	it("answers as JSON, with the reference copy's commit", async () => {
		const { tool, contexts } = setup([`I read a.ts.\n${ok}`]);
		const r = await tool.execute("t1", {
			question: "Is alert 12 real?",
			answer_schema: SCHEMA,
			skill_file: join(workdir, "SKILL.md"),
			briefing: "Alert 12: semgrep path-from-request at a.ts:3",
			reference: "magi-v3",
		});
		expect(r.isError).toBeFalsy();
		const out = JSON.parse((r.content[0] as { text: string }).text);
		expect(out).toEqual({
			answer: { verdict: "false-positive", evidence: ["a.ts:3"] },
			reference: { name: "magi-v3", commit: COMMIT },
			turns: 1,
		});
		const ctx = contexts[0];
		expect(ctx.systemPrompt).toContain("Check whether the alert is real.");
		const task = JSON.stringify(ctx.messages);
		expect(task).toContain("Alert 12: semgrep path-from-request");
		expect(task).toContain(
			`/var/lib/magi/reference/magi-v3/current\` (commit ${COMMIT})`,
		);
		expect(task).toContain("false-positive");
	});

	it("starts with none of the caller's history: one message, the task", async () => {
		const { tool, contexts } = setup([ok]);
		await tool.execute("t1", { question: "Q?", answer_schema: SCHEMA });
		expect(contexts[0].messages).toHaveLength(1);
		expect(contexts[0].messages[0].role).toBe("user");
	});

	it("gives one repair turn to an answer that does not match, without tools", async () => {
		const { tool, contexts } = setup(['{"verdict":"maybe"}', ok]);
		const r = await tool.execute("t1", {
			question: "Q?",
			answer_schema: SCHEMA,
		});
		expect(r.isError).toBeFalsy();
		expect(JSON.parse((r.content[0] as { text: string }).text).turns).toBe(2);
		expect(JSON.stringify(contexts[1].messages.at(-1))).toMatch(
			/does not match the schema/,
		);
		expect(contexts[1].tools ?? []).toHaveLength(0);
	});

	it("fails when the repair does not match either", async () => {
		const { tool } = setup(["no json here", "still none"]);
		const r = await tool.execute("t1", {
			question: "Q?",
			answer_schema: SCHEMA,
		});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toMatch(
			/did not match the schema after one repair/,
		);
	});

	it("tells an investigation that ran out of turns to answer from what it found", async () => {
		const toolCall = {
			...reply(""),
			content: [
				{
					type: "toolCall",
					id: "c1",
					name: "Bash",
					arguments: { command: "ls" },
				},
			],
			stopReason: "toolUse",
		} as AssistantMessage;
		const { tool, contexts } = setup([toolCall, toolCall, ok]);
		const r = await tool.execute("t1", {
			question: "Q?",
			answer_schema: SCHEMA,
			max_turns: 2,
		});
		expect(r.isError).toBeFalsy();
		expect(JSON.stringify(contexts.at(-1)?.messages.at(-1))).toMatch(
			/used all 2 turns/,
		);
	});

	it("reports a failed model call as such, without a repair turn", async () => {
		const failed = {
			...reply(""),
			content: [],
			stopReason: "error",
			errorMessage: '401 {"type":"authentication_error"}',
		} as AssistantMessage;
		const { tool, contexts } = setup([failed]);
		const r = await tool.execute("t1", {
			question: "Q?",
			answer_schema: SCHEMA,
		});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toMatch(
			/model call failed \(error\): 401/,
		);
		expect(contexts).toHaveLength(1);
	});

	it.each([
		[
			"no question",
			{ question: " ", answer_schema: SCHEMA },
			/question is required/,
		],
		[
			"an invalid schema",
			{ question: "Q?", answer_schema: { type: "nonsense" } },
			/not a valid JSON Schema/,
		],
		[
			"a skill outside the permitted paths",
			{ question: "Q?", answer_schema: SCHEMA, skill_file: "SKILL_OUT" },
			/not within permitted paths/,
		],
		[
			"a reference that is not a name",
			{ question: "Q?", answer_schema: SCHEMA, reference: "../etc" },
			/not a valid name/,
		],
	])("refuses %s before any model call", async (_what, args, message) => {
		const { tool, contexts } = setup([ok]);
		const a = { ...args } as Record<string, unknown>;
		if (a.skill_file === "SKILL_OUT") a.skill_file = join(outside, "SKILL.md");
		const r = await tool.execute("t1", a);
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toMatch(message);
		expect(contexts).toHaveLength(0);
	});

	it("refuses a reference copy without a readable commit", async () => {
		const { tool, contexts } = setup([ok], "not json");
		const r = await tool.execute("t1", {
			question: "Q?",
			answer_schema: SCHEMA,
			reference: "magi-v3",
		});
		expect(r.isError).toBe(true);
		expect(contexts).toHaveLength(0);
	});
});

describe("extractJson", () => {
	it("takes the last json fence", () => {
		expect(
			extractJson('```json\n{"a":1}\n```\nthen\n```json\n{"a":2}\n```'),
		).toEqual({ a: 2 });
	});
	it("takes JSON after prose", () => {
		expect(extractJson('Done.\n{"a":[1,2]}')).toEqual({ a: [1, 2] });
	});
	it("is not misled by a fence in another language before the answer", () => {
		const text =
			'The guard:\n```typescript\nif (a) {\n```\nSo it holds.\n```json\n{"verdict": "real"}\n```';
		expect(extractJson(text)).toEqual({ verdict: "real" });
	});

	it("falls back to an earlier JSON fence when the last does not parse", () => {
		expect(extractJson('```json\n{"a":1}\n```\n```json\n{oops\n```')).toEqual({
			a: 1,
		});
	});

	it("finds nothing in prose", () => {
		expect(extractJson("no answer")).toBeUndefined();
	});
});
