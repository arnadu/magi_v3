import type { TeamConfig } from "@magi/agent-config";
import { describe, expect, it } from "vitest";
import {
	createMailboxTools,
	type MailboxMessage,
	type MailboxRepository,
} from "../src/mailbox.js";
import { checkToolArguments } from "../src/tool-args.js";
import type { MagiTool } from "../src/tools.js";

function fakeRepo(listResult: MailboxMessage[] = []): MailboxRepository & {
	posted: MailboxMessage[];
	listCalls: Array<{ limit?: number; since?: Date; search?: string }>;
} {
	const posted: MailboxMessage[] = [];
	const listCalls: Array<{ limit?: number; since?: Date; search?: string }> =
		[];
	return {
		posted,
		listCalls,
		async post(msg) {
			const full: MailboxMessage = {
				...msg,
				id: String(posted.length),
				timestamp: new Date(),
				readBy: [],
			};
			posted.push(full);
			return full;
		},
		async listUnread() {
			return [];
		},
		async markRead() {},
		async hasUnread() {
			return false;
		},
		async list(_agentId, opts) {
			listCalls.push(opts ?? {});
			return listResult;
		},
		async get() {
			return null;
		},
	};
}

const teamConfig: TeamConfig = {
	mission: { id: "test-mission", name: "Test" },
	agents: [
		{
			id: "analyst",
			supervisor: "user",
			systemPrompt: "x",
			initialMentalMap: "x",
		},
	],
};

function findPostMessage(repo: MailboxRepository) {
	const tools = createMailboxTools(repo, teamConfig, "job-script");
	const tool = tools.find((t) => t.name === "PostMessage");
	if (!tool) throw new Error("PostMessage tool not registered");
	return tool;
}

/** The tool as the loop and the Tool API call it: arguments validated first. */
async function validatedCall(tool: MagiTool, args: Record<string, unknown>) {
	const checked = checkToolArguments(tool, {
		id: "id1",
		name: tool.name,
		arguments: args,
	});
	if (!checked.ok) throw new Error(checked.message);
	return tool.execute("id1", checked.args);
}

describe("PostMessage", () => {
	it("accepts to as an array (the LLM-schema-conformant shape)", async () => {
		const repo = fakeRepo();
		const tool = findPostMessage(repo);
		const result = await tool.execute("id1", {
			to: ["analyst"],
			subject: "s",
			body: "b",
		});
		expect(result.isError).toBeFalsy();
		expect(repo.posted).toHaveLength(1);
		expect(repo.posted[0].to).toEqual(["analyst"]);
	});

	it("accepts to as a bare string (the Tool API path, e.g. magi_tool.py) once validated", async () => {
		const repo = fakeRepo();
		const tool = findPostMessage(repo);
		const result = await validatedCall(tool, {
			to: "analyst",
			subject: "s",
			body: "b",
		});
		expect(result.isError).toBeFalsy();
		expect(repo.posted[0].to).toEqual(["analyst"]);
	});

	it("reads a JSON-encoded list in a string as the list once validated", async () => {
		const repo = fakeRepo();
		const tool = findPostMessage(repo);
		const result = await validatedCall(tool, {
			to: '["analyst", "user"]',
			subject: "s",
			body: "b",
		});
		expect(result.isError).toBeFalsy();
		expect(repo.posted[0].to).toEqual(["analyst", "user"]);
	});

	it("rejects an unknown recipient", async () => {
		const repo = fakeRepo();
		const tool = findPostMessage(repo);
		const result = await tool.execute("id1", {
			to: ["nobody"],
			subject: "s",
			body: "b",
		});
		expect(result.isError).toBe(true);
		expect(repo.posted).toHaveLength(0);
		// The model is told what it sent and what would have worked.
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain('["nobody"]');
		expect(text).toContain("Valid recipients: analyst");
	});
});

describe("ListMessages", () => {
	it("includes every recipient, not just the caller, so a co-addressed agent can see who else got the message", async () => {
		const msg: MailboxMessage = {
			id: "m1",
			missionId: "test-mission",
			from: "user",
			to: ["analyst", "mission-copilot"],
			subject: "Shared task",
			body: "b",
			timestamp: new Date("2026-07-16T11:33:00.000Z"),
			readBy: [],
		};
		const repo = fakeRepo([msg]);
		const tools = createMailboxTools(repo, teamConfig, "job-script");
		const tool = tools.find((t) => t.name === "ListMessages");
		if (!tool) throw new Error("ListMessages tool not registered");
		const result = await tool.execute("id1", {});
		expect(result.content[0].text).toContain("to=analyst,mission-copilot");
	});

	it("clamps a requested limit above the ceiling instead of passing it through verbatim", async () => {
		const repo = fakeRepo([]);
		const tools = createMailboxTools(repo, teamConfig, "job-script");
		const tool = tools.find((t) => t.name === "ListMessages");
		if (!tool) throw new Error("ListMessages tool not registered");
		await tool.execute("id1", { limit: 10_000 });
		expect(repo.listCalls).toHaveLength(1);
		expect(repo.listCalls[0].limit).toBe(100);
	});

	it("truncates a long result instead of returning it unbounded", async () => {
		const messages: MailboxMessage[] = Array.from({ length: 600 }, (_, i) => ({
			id: String(i),
			missionId: "test-mission",
			from: "user",
			to: ["analyst"],
			subject: `subject ${i}`,
			body: "b",
			timestamp: new Date("2026-07-16T11:33:00.000Z"),
			readBy: [],
		}));
		const repo = fakeRepo(messages);
		const tools = createMailboxTools(repo, teamConfig, "job-script");
		const tool = tools.find((t) => t.name === "ListMessages");
		if (!tool) throw new Error("ListMessages tool not registered");
		const result = await tool.execute("id1", {});
		expect(result.content[0].text).toContain(
			// Both caps apply (T2): the 500 kept lines also exceed the character
			// cap, so the note reports the character cut and the line total.
			"[Output truncated at 20000 chars; 600 lines total]",
		);
	});
});
