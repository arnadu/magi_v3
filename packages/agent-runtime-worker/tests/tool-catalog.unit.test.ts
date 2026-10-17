/**
 * TIER_A_TOOL_NAMES must equal what the agent runner's factories build —
 * the cockpit's "disable tool" list is generated from it (SKILLS-DRIFT).
 */
import type { TeamConfig } from "@magi/agent-config";
import { describe, expect, it } from "vitest";
import { createMailboxTools } from "../src/mailbox.js";
import { createMentalMapTools } from "../src/mental-map.js";
import { CLAUDE_SONNET } from "../src/models.js";
import { createObjectivesTools } from "../src/objectives/tools.js";
import {
	CONDITIONAL_TOOL_NAMES,
	TIER_A_TOOL_NAMES,
} from "../src/tool-catalog.js";
import { createAnalyzeMemoriesTool } from "../src/tools/analyze-memories.js";
import { createFetchUrlTool } from "../src/tools/fetch-url.js";
import { createInspectImageTool } from "../src/tools/inspect-image.js";
import { createResearchTool } from "../src/tools/research.js";
import { createFileTools } from "../src/tools.js";

describe("TIER_A_TOOL_NAMES", () => {
	it("matches the names the runner's tool factories produce", () => {
		const acl = { agentId: "a", linuxUser: "u", permittedPaths: ["/tmp"] };
		const built = [
			...createFileTools("/tmp", acl),
			...createMailboxTools(
				{} as never,
				{ agents: [{ id: "a" }] } as unknown as TeamConfig,
				"a",
			),
			...createMentalMapTools(
				() => "",
				() => {},
			),
			createFetchUrlTool(CLAUDE_SONNET, "/tmp", []),
			createInspectImageTool("/tmp", CLAUDE_SONNET),
			createResearchTool(CLAUDE_SONNET, "/tmp", acl),
			createAnalyzeMemoriesTool({
				conversationRepo: {} as never,
				agentId: "a",
				missionId: "m",
			}),
			...createObjectivesTools({} as never, "m", "a"),
		].map((t) => t.name);

		const listed = new Set<string>(TIER_A_TOOL_NAMES);
		for (const name of built) expect(listed.has(name), name).toBe(true);
		const unbuilt = TIER_A_TOOL_NAMES.filter((n) => !built.includes(n));
		expect(unbuilt.every((n) => CONDITIONAL_TOOL_NAMES.has(n))).toBe(true);
	});
});
