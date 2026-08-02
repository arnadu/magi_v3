/**
 * ADR-0018 follow-up: unit tests for `resolveLiveLimits`, the pure function
 * behind `enforceLimits`'s live-config read. Covers the mission-copilot bug
 * found during review (its limits live in a separate top-level TeamConfig
 * field, not `agents[]`) and the "explicit clear must not fall back to a
 * stale snapshot" semantics.
 */

import type { TeamConfig } from "@magi/agent-config";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
	forceCompactSession,
	isConversationStructureError,
	resolveLiveLimits,
} from "../src/agent-runner.js";
import type {
	ConversationRepository,
	StoredMessage,
} from "../src/conversation-repository.js";
import { MISSION_COPILOT_AGENT_ID } from "../src/mission-copilot.js";

function teamConfig(overrides: Partial<TeamConfig> = {}): TeamConfig {
	return {
		mission: { id: "m1", name: "Test Mission" },
		agents: [
			{
				id: "analyst",
				supervisor: "user",
				systemPrompt: "x",
				initialMentalMap: "<section></section>",
				limits: { maxLlmCallsPerTurn: 10 },
			},
			{
				id: "trader",
				supervisor: "user",
				systemPrompt: "x",
				initialMentalMap: "<section></section>",
				// no limits configured
			},
		],
		...overrides,
	} as TeamConfig;
}

describe("resolveLiveLimits", () => {
	it("falls back to the boot-time snapshot when live is null (read failed / doc missing)", () => {
		const fallback = { maxLlmCallsPerTurn: 1 };
		expect(resolveLiveLimits(null, "analyst", fallback)).toBe(fallback);
	});

	it("returns the live agent's limits when present, overriding the snapshot", () => {
		const live = teamConfig();
		const result = resolveLiveLimits(live, "analyst", {
			maxLlmCallsPerTurn: 999,
		});
		expect(result).toEqual({ maxLlmCallsPerTurn: 10 });
	});

	it("treats an agent with no live limits as genuinely having none — does NOT fall back to the stale snapshot", () => {
		// This is the "operator cleared a limit" case: the live doc was
		// successfully read, the agent exists, it just has no limits node.
		// Falling back here would silently keep enforcing a cleared limit.
		const live = teamConfig();
		const result = resolveLiveLimits(live, "trader", {
			maxLlmCallsPerTurn: 999,
		});
		expect(result).toEqual({});
	});

	it("resolves the mission copilot's limits from missionCopilotLimits, not agents[]", () => {
		const live = teamConfig({
			missionCopilotLimits: { maxCostPerTurnUsd: 5 },
		});
		const result = resolveLiveLimits(live, MISSION_COPILOT_AGENT_ID, {
			maxCostPerTurnUsd: 999,
		});
		expect(result).toEqual({ maxCostPerTurnUsd: 5 });
	});

	it("returns {} for the mission copilot when missionCopilotLimits is unset, not the stale snapshot", () => {
		const live = teamConfig(); // no missionCopilotLimits
		const result = resolveLiveLimits(live, MISSION_COPILOT_AGENT_ID, {
			maxCostPerTurnUsd: 999,
		});
		expect(result).toEqual({});
	});

	it("returns {} when the agentId isn't found in live.agents (config drift), not the stale snapshot", () => {
		const live = teamConfig();
		const result = resolveLiveLimits(live, "ghost-agent", {
			maxLlmCallsPerTurn: 999,
		});
		expect(result).toEqual({});
	});
});

/**
 * In-memory ConversationRepository, just enough of the contract for
 * forceCompactSession: load()/append()/compact() with real turnNumber-based
 * filtering, matching the MongoDB implementation's semantics exactly.
 */
function fakeConversationRepo(
	seed: (StoredMessage & { compacted?: boolean })[],
): ConversationRepository {
	const docs = [...seed];
	return {
		async load() {
			return docs.filter((d) => !d.compacted);
		},
		async append(_agentId, _missionId, messages) {
			docs.push(...messages);
		},
		async compact(_agentId, _missionId, keepFrom) {
			for (const d of docs) {
				if (d.turnNumber < keepFrom) d.compacted = true;
			}
		},
		async loadMostRecentMentalMap() {
			return null;
		},
		async findRelevant() {
			return [];
		},
	};
}

function assistantWithDanglingToolCall(turnNumber: number): StoredMessage {
	const msg: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "toolu_stuck",
				name: "ProposeAction",
				arguments: {},
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	return { turnNumber, message: msg };
}

describe("isConversationStructureError", () => {
	function errorMsg(errorMessage: string): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage,
			timestamp: Date.now(),
		};
	}

	it("matches the real Anthropic tool_use_id pairing error (verbatim, from the live incident)", () => {
		expect(
			isConversationStructureError(
				errorMsg(
					'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.182.content.1: unexpected `tool_use_id` found in `tool_result` blocks: toolu_017bPA9pDMSSxYnZNWHkBXf6. Each `tool_result` block must have a corresponding `tool_use` block in the previous message."}}',
				),
			),
		).toBe(true);
	});

	it("does not match a successful message", () => {
		const ok: AssistantMessage = {
			...errorMsg(""),
			stopReason: "stop",
			errorMessage: undefined,
		};
		expect(isConversationStructureError(ok)).toBe(false);
	});

	it("does not match an unrelated error (e.g. rate limit)", () => {
		expect(
			isConversationStructureError(errorMsg("429 rate limit exceeded")),
		).toBe(false);
	});
});

describe("forceCompactSession", () => {
	it("the recovery summary survives its own compaction — regression for the boundary bug found live", async () => {
		// Mirrors the actual incident: a dangling tool_use at turn 38, plus a
		// couple of failed retries (39-40), then the recovery fires at turn 41
		// (the turn number active when the structure error occurred).
		const repo = fakeConversationRepo([
			assistantWithDanglingToolCall(38),
			assistantWithDanglingToolCall(39),
			assistantWithDanglingToolCall(40),
		]);

		await forceCompactSession("copilot", "copilot-test", 41, repo);

		const remaining = await repo.load("copilot", "copilot-test");
		// Before the fix: this was empty — the summary was written at
		// nextTurnNumber - 1 (40), which is always < the compact cutoff
		// (nextTurnNumber + 1 = 42), so compact() immediately marked the
		// summary itself compacted too. The whole point of this function —
		// "the next load() returns only the recovery summary" — silently
		// never held.
		expect(remaining).toHaveLength(1);
		expect(remaining[0].message.role).toBe("summary");
	});

	it("compacts away everything before the summary, including the failed session's own messages", async () => {
		const repo = fakeConversationRepo([assistantWithDanglingToolCall(38)]);
		await forceCompactSession("copilot", "copilot-test", 38, repo);
		const remaining = await repo.load("copilot", "copilot-test");
		expect(remaining).toHaveLength(1);
		expect(remaining[0].message.role).toBe("summary");
	});
});
