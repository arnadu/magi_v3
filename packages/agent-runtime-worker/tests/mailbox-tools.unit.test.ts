import type { TeamConfig } from "@magi/agent-config";
import { describe, expect, it } from "vitest";
import {
	createMailboxTools,
	type MailboxMessage,
	type MailboxRepository,
} from "../src/mailbox.js";

function fakeRepo(
	listResult: MailboxMessage[] = [],
): MailboxRepository & { posted: MailboxMessage[] } {
	const posted: MailboxMessage[] = [];
	return {
		posted,
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
		async list() {
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

	it("accepts to as a bare string (the raw tool-api-server path, e.g. magi_tool.py) without throwing", async () => {
		const repo = fakeRepo();
		const tool = findPostMessage(repo);
		const result = await tool.execute("id1", {
			to: "analyst",
			subject: "s",
			body: "b",
		});
		expect(result.isError).toBeFalsy();
		expect(repo.posted[0].to).toEqual(["analyst"]);
	});

	it("returns a clean error (not a thrown TypeError) for a non-string/array to", async () => {
		const repo = fakeRepo();
		const tool = findPostMessage(repo);
		const result = await tool.execute("id1", {
			to: 42,
			subject: "s",
			body: "b",
		});
		expect(result.isError).toBe(true);
		expect(repo.posted).toHaveLength(0);
	});

	it("rejects an unknown recipient", async () => {
		const repo = fakeRepo();
		const tool = findPostMessage(repo);
		const result = await tool.execute("id1", {
			to: "nobody",
			subject: "s",
			body: "b",
		});
		expect(result.isError).toBe(true);
		expect(repo.posted).toHaveLength(0);
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
});
