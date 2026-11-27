/**
 * RS1: an operator who disables a tool for an agent must not get it back
 * through Research's sub-loop.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingHooks } from "./sub-agent-hooks.js";

const seenTools: string[][] = [];
type FinalStep = {
	timeBudgetMs?: number;
	notice: (reason: "turns" | "time") => string;
};
const seenLoops: { maxTurns?: number; finalStep?: FinalStep }[] = [];
vi.mock("../src/loop.js", () => ({
	runInnerLoop: async (cfg: {
		tools: Array<{ name: string }>;
		maxTurns?: number;
		finalStep?: FinalStep;
	}) => {
		seenTools.push(cfg.tools.map((t) => t.name));
		seenLoops.push({ maxTurns: cfg.maxTurns, finalStep: cfg.finalStep });
		return { messages: [], turnCount: 1 };
	},
}));

const { createResearchTool } = await import("../src/tools/research.js");

const base = mkdtempSync(join(tmpdir(), "magi-rs1-"));
const shared = join(base, "shared");
mkdirSync(shared, { recursive: true });
afterEach(() => {
	seenTools.length = 0;
	seenLoops.length = 0;
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
			hooks: recordingHooks().hooks,
			disabledTools: ["Bash", "BrowseWeb"],
		});
		await tool.execute("t1", { question: "what is x?", max_age_hours: 0 });
		expect(seenTools[0]).toContain("FetchUrl");
		expect(seenTools[0]).not.toContain("Bash");
		expect(seenTools[0]).not.toContain("BrowseWeb");
	});

	it("keeps every tool when nothing is disabled", async () => {
		const tool = createResearchTool(model, shared, acl, {
			hooks: recordingHooks().hooks,
		});
		await tool.execute("t1", { question: "what is y?", max_age_hours: 0 });
		expect(seenTools[0]).toEqual(expect.arrayContaining(["FetchUrl", "Bash"]));
	});
});

describe("turn.sub-agent-bounded: Research's sub-loop", () => {
	it("has a time budget and a turn cap, both ending in a last step that names the budget", async () => {
		const tool = createResearchTool(model, shared, acl, {
			hooks: recordingHooks().hooks,
		});
		await tool.execute("t1", { question: "what is z?", max_age_hours: 0 });
		const loop = seenLoops[0];
		expect(loop.maxTurns).toBe(10);
		expect(loop.finalStep?.timeBudgetMs).toBe(6 * 60_000);
		// The notice's wording is judged by reading; the code fills in the budget that ran out.
		expect(loop.finalStep?.notice("time")).toContain("6 minutes");
		expect(loop.finalStep?.notice("turns")).toContain("all 10 of your turns");
	});
});
