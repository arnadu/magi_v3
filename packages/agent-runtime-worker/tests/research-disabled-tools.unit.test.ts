/**
 * RS1: an operator who disables a tool for an agent must not get it back
 * through Research's sub-loop.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const seenTools: string[][] = [];
vi.mock("../src/loop.js", () => ({
	runInnerLoop: async (cfg: { tools: Array<{ name: string }> }) => {
		seenTools.push(cfg.tools.map((t) => t.name));
		return { messages: [], turnCount: 1 };
	},
}));

const { createResearchTool } = await import("../src/tools/research.js");

const base = mkdtempSync(join(tmpdir(), "magi-rs1-"));
const shared = join(base, "shared");
mkdirSync(shared, { recursive: true });
afterEach(() => {
	seenTools.length = 0;
});
process.on("exit", () => rmSync(base, { recursive: true, force: true }));

const model = {
	id: "stub",
	provider: "anthropic",
	input: ["text"],
} as unknown as Model<string>;
const acl = { agentId: "a1", linuxUser: "magi-w1", permittedPaths: [shared] };

describe("Research honours the agent's disabledTools", () => {
	it("hands the sub-loop only the tools the agent may use", async () => {
		const tool = createResearchTool(model, shared, acl, {
			disabledTools: ["Bash", "BrowseWeb"],
		});
		await tool.execute("t1", { question: "what is x?", max_age_hours: 0 });
		expect(seenTools[0]).toContain("FetchUrl");
		expect(seenTools[0]).not.toContain("Bash");
		expect(seenTools[0]).not.toContain("BrowseWeb");
	});

	it("keeps every tool when nothing is disabled", async () => {
		const tool = createResearchTool(model, shared, acl);
		await tool.execute("t1", { question: "what is y?", max_age_hours: 0 });
		expect(seenTools[0]).toEqual(expect.arrayContaining(["FetchUrl", "Bash"]));
	});
});
