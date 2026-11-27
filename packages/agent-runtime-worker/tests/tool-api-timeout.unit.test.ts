/**
 * A background job's tool call runs as long as the tool declares (Research's and Investigate's
 * minutes), not a flat 120 s that cut sub-agents short.
 */
import { describe, expect, it } from "vitest";
import { CLAUDE_SONNET } from "../src/models.js";
import { toolTimeoutMs } from "../src/tool-api-server.js";
import { createInvestigateTool } from "../src/tools/investigate.js";
import { recordingHooks } from "./sub-agent-hooks.js";

describe("toolTimeoutMs", () => {
	it("uses the tool's declared runtime", () => {
		const investigate = createInvestigateTool(
			CLAUDE_SONNET,
			{ agentId: "a", linuxUser: "u", permittedPaths: ["/tmp"] },
			{ workdir: "/tmp", hooks: recordingHooks().hooks },
		);
		expect(toolTimeoutMs(investigate, {})).toBe(10 * 60_000);
	});

	it("falls back to 120 s for a tool that declares none", () => {
		expect(toolTimeoutMs({}, {})).toBe(120_000);
	});
});
