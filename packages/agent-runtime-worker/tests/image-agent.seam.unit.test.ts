/**
 * The image sub-agent end to end with a scripted model and a fake image
 * client (ADR-0035): brief → generate → critique → finish, files and
 * manifest, the budget stops, abort, and the sub-agent's tool boundary.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ImageAgentDeps,
	type ImageJobRequest,
	runImageJob,
} from "../src/images/image-agent.js";
import type {
	GenerateImageRequest,
	GenerateImageResult,
} from "../src/images/image-client.js";
import type { LlmCallEvent } from "../src/llm-meter.js";
import type { CompleteFn } from "../src/loop.js";
import { CLAUDE_SONNET } from "../src/models.js";

const SVG = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
);
const PNG = Buffer.from("iVBORw0KGgo=", "base64");
const VECTOR = "recraft/recraft-v4.1-vector";
const FLUX = "black-forest-labs/flux.2-pro";

type Call = { name: string; arguments: Record<string, unknown> };

function assistant(calls: Call[], text = ""): AssistantMessage {
	return {
		role: "assistant",
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...calls.map((c, i) => ({
				type: "toolCall" as const,
				id: `t${Date.now()}-${i}`,
				name: c.name,
				arguments: c.arguments,
			})),
		],
		api: "openai-completions",
		provider: "openrouter",
		model: "anthropic/claude-sonnet-5",
		usage: {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			providerCost: 0.01,
		} as AssistantMessage["usage"],
		stopReason: calls.length ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

/** A scripted sub-agent: each loop call returns the next step; critique calls (no tools) get a canned critique. */
function scripted(steps: Call[][], seen: { tools: string[][] }): CompleteFn {
	let i = 0;
	return async (_m, context: Context) => {
		if (!context.tools?.length) {
			return assistant([], "Candidate 1 scores 8; candidate 2 scores 6.");
		}
		seen.tools.push(context.tools.map((t) => t.name));
		const step = steps[i++];
		return step ? assistant(step) : assistant([], "Done without finish.");
	};
}

function fakeGenerate(
	calls: GenerateImageRequest[],
	cost = 0.05,
): (req: GenerateImageRequest) => Promise<GenerateImageResult> {
	return async (req) => {
		calls.push(req);
		const svg = req.modelId === VECTOR;
		return {
			modelId: req.modelId,
			images: [
				svg
					? { mimeType: "image/svg+xml", bytes: SVG }
					: { mimeType: "image/png", bytes: PNG },
			],
			costUsd: cost,
			costEstimated: false,
			tokens: { input: 0, output: 0 },
		};
	};
}

const gen = (model: string, prompt = "a fern") => ({
	name: "generate_image",
	arguments: { model, prompt, rationale: "first direction" },
});

let shared: string;
beforeEach(() => {
	shared = mkdtempSync(join(tmpdir(), "img-agent-"));
});
afterEach(() => rmSync(shared, { recursive: true, force: true }));

function request(over: Partial<ImageJobRequest> = {}): ImageJobRequest {
	return {
		brief: "A logo for a hotel for houseplants",
		options: 2,
		references: [],
		maxImages: 8,
		maxUsd: 1.5,
		...over,
	};
}

function deps(
	completeFn: CompleteFn,
	generate: ImageAgentDeps["generate"],
	events: LlmCallEvent[] = [],
	over: Partial<ImageAgentDeps> = {},
): ImageAgentDeps {
	return {
		agentModel: CLAUDE_SONNET,
		sharedDir: shared,
		agentId: "designer",
		meter: async (e) => {
			events.push(e);
		},
		completeFn,
		generate,
		renderPreviews: async (sources) => sources.map(() => Buffer.from("jpeg")),
		...over,
	};
}

describe("image sub-agent (seam)", () => {
	it("generates, critiques and finishes; writes files, manifest and contact sheet; charges every call", async () => {
		const seen = { tools: [] as string[][] };
		const calls: GenerateImageRequest[] = [];
		const events: LlmCallEvent[] = [];
		const completeFn = scripted(
			[
				[gen(VECTOR), gen(FLUX)],
				[{ name: "critique_candidates", arguments: {} }],
				[
					{
						name: "finish",
						arguments: {
							summary: "Two options; the SVG is stronger.",
							recommended: [1, 7],
							notes: [{ candidate: 1, note: "clean mark" }],
						},
					},
				],
				[gen(FLUX, "should never run")],
			],
			seen,
		);
		const out = await runImageJob(
			deps(completeFn, fakeGenerate(calls), events),
			request(),
		);
		const m = out.manifest;
		expect(m.status).toBe("complete");
		expect(calls.map((c) => c.modelId)).toEqual([VECTOR, FLUX]);
		expect(m.candidates.map((c) => c.file)).toEqual([
			"candidate-1.svg",
			"candidate-2.png",
		]);
		expect(m.recommended).toEqual([1]);
		expect(m.candidates[0].note).toBe("clean mark");
		expect(m.critiques).toHaveLength(1);
		// finish ended the loop before a 4th sub-agent call.
		expect(seen.tools).toHaveLength(3);
		for (const names of seen.tools) {
			expect(names.sort()).toEqual([
				"critique_candidates",
				"finish",
				"generate_image",
			]);
		}
		const dir = join(shared, out.jobDir);
		expect(readFileSync(join(dir, "candidate-1.svg"))).toEqual(SVG);
		const onDisk = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
		expect(onDisk.status).toBe("complete");
		expect(existsSync(join(shared, out.contactSheet ?? "x"))).toBe(true);
		// 2 generations at their fixed cost + 3 loop calls + 1 critique call.
		expect(events.filter((e) => e.fixedCost)).toHaveLength(2);
		expect(events.filter((e) => !e.fixedCost)).toHaveLength(4);
		expect(m.totals.imageUsd).toBeCloseTo(0.1);
		expect(m.totals.agentUsd).toBeCloseTo(0.04);
		expect(m.totals.totalUsd).toBeCloseTo(0.14);
	});

	it("stops generating at maxImages", async () => {
		const calls: GenerateImageRequest[] = [];
		const completeFn = scripted(
			[[gen(FLUX)], [gen(FLUX)], [gen(FLUX)], [gen(FLUX)]],
			{ tools: [] },
		);
		const out = await runImageJob(
			deps(completeFn, fakeGenerate(calls)),
			request({ maxImages: 2 }),
		);
		expect(calls).toHaveLength(2);
		expect(out.manifest.candidates).toHaveLength(2);
		expect(out.manifest.status).toBe("partial");
	});

	it("refuses a generation whose ceiling price would pass maxUsd, and stops calling the model once maxUsd is spent", async () => {
		const calls: GenerateImageRequest[] = [];
		const seen = { tools: [] as string[][] };
		// FLUX's ceiling is $0.20: the second call would pass $0.30.
		const completeFn = scripted(
			[[gen(FLUX)], [gen(FLUX)], [gen(FLUX)], [gen(FLUX)]],
			seen,
		);
		const out = await runImageJob(
			deps(completeFn, fakeGenerate(calls, 0.2)),
			request({ maxUsd: 0.3 }),
		);
		expect(calls).toHaveLength(1);
		expect(out.manifest.status).toBe("partial");
		expect(out.manifest.statusDetail).toMatch(/budget/);
		expect(out.manifest.totals.totalUsd).toBeLessThanOrEqual(0.3 + 0.01);
	});

	it("leaves a valid partial manifest when aborted mid-job", async () => {
		const ac = new AbortController();
		const calls: GenerateImageRequest[] = [];
		const inner = fakeGenerate(calls);
		const completeFn = scripted([[gen(FLUX)], [gen(FLUX)], [gen(FLUX)]], {
			tools: [],
		});
		const out = await runImageJob(
			deps(completeFn, async (req) => {
				const r = await inner(req);
				ac.abort();
				return r;
			}),
			request(),
			ac.signal,
		);
		expect(calls).toHaveLength(1);
		expect(out.manifest.status).toBe("partial");
		expect(out.manifest.statusDetail).toMatch(/aborted/);
		const onDisk = JSON.parse(
			readFileSync(join(shared, out.jobDir, "manifest.json"), "utf8"),
		);
		expect(onDisk.candidates).toHaveLength(1);
	});

	it("keeps the image and stops the job when charging it fails (a hard limit)", async () => {
		const calls: GenerateImageRequest[] = [];
		const completeFn = scripted([[gen(FLUX)], [gen(FLUX)]], { tools: [] });
		const out = await runImageJob(
			deps(completeFn, fakeGenerate(calls), [], {
				meter: async (e) => {
					if (e.fixedCost) throw new Error("hard limit: cost per turn");
				},
			}),
			request(),
		);
		expect(calls).toHaveLength(1);
		expect(out.manifest.candidates).toHaveLength(1);
		expect(out.manifest.status).toBe("partial");
		expect(out.manifest.statusDetail).toMatch(/hard limit/);
	});

	it("uses the closing text as the summary when finish is never called", async () => {
		const completeFn = scripted([[gen(FLUX)]], { tools: [] });
		const out = await runImageJob(
			deps(completeFn, fakeGenerate([])),
			request(),
		);
		expect(out.manifest.status).toBe("partial");
		expect(out.manifest.summary).toBe("Done without finish.");
	});

	it("refuses a menu kind the mission did not enable", async () => {
		const calls: GenerateImageRequest[] = [];
		const completeFn = scripted([[gen(VECTOR)]], { tools: [] });
		const out = await runImageJob(
			deps(completeFn, fakeGenerate(calls), [], {
				allowedKinds: ["raster-art"],
			}),
			request(),
		);
		expect(calls).toHaveLength(0);
		expect(out.manifest.status).toBe("failed");
	});

	it("passes its own SVG candidate as a rendered raster reference", async () => {
		const calls: GenerateImageRequest[] = [];
		const completeFn = scripted(
			[
				[gen(VECTOR)],
				[
					{
						name: "generate_image",
						arguments: {
							model: "google/gemini-3.1-flash-lite-image",
							prompt: "make the leaf gold",
							references: ["candidate-1"],
						},
					},
				],
			],
			{ tools: [] },
		);
		await runImageJob(deps(completeFn, fakeGenerate(calls)), request());
		expect(calls[1].references).toEqual([
			{ mimeType: "image/jpeg", data: Buffer.from("jpeg").toString("base64") },
		]);
	});
});
