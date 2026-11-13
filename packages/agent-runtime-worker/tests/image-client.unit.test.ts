import type { ImagesResponse } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLlmCallHook } from "../src/agent-runner-llm-log.js";
import {
	chargeFor,
	type GenerateImageResult,
	type GenerateImagesFn,
	generateImage,
	imageMeterEvent,
	MAX_REFERENCE_IMAGES,
	validateReferences,
} from "../src/images/image-client.js";
import { createLogOnlyMeter } from "../src/llm-meter.js";
import { CLAUDE_HAIKU } from "../src/models.js";

const PNG = "iVBORw0KGgo=";
const FLUX = "black-forest-labs/flux.2-pro";

function stubResponse(over: Partial<ImagesResponse> = {}): ImagesResponse {
	return {
		api: "openrouter-images",
		provider: "openrouter",
		model: FLUX,
		output: [{ type: "image", mimeType: "image/png", data: PNG }],
		stopReason: "stop",
		timestamp: 0,
		...over,
	} as ImagesResponse;
}

const anyModel = () => ({ id: FLUX }) as never;

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("generateImage through pi-ai (stubbed network)", () => {
	it("sends usage and aspect ratio, and records OpenRouter's reported charge", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		let sent: Record<string, unknown> | undefined;
		let url = "";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				url = String(input);
				sent = JSON.parse(String(init?.body));
				return new Response(
					JSON.stringify({
						id: "gen-1",
						choices: [
							{
								message: {
									role: "assistant",
									content: "",
									images: [
										{
											type: "image_url",
											image_url: { url: `data:image/png;base64,${PNG}` },
										},
									],
								},
							},
						],
						usage: { prompt_tokens: 12, completion_tokens: 0, cost: 0.03 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		);
		const result = await generateImage({
			modelId: FLUX,
			prompt: "a fern",
			aspectRatio: "16:9",
		});
		expect(url).toContain("openrouter.ai");
		expect(sent?.model).toBe(FLUX);
		expect(sent?.usage).toEqual({ include: true });
		expect(sent?.image_config).toEqual({ aspect_ratio: "16:9" });
		expect(result.costUsd).toBe(0.03);
		expect(result.costEstimated).toBe(false);
		expect(result.responseId).toBe("gen-1");
		expect(result.images[0].bytes).toEqual(Buffer.from(PNG, "base64"));
	});
});

describe("generateImage (stubbed generate)", () => {
	const run = (
		resp: ImagesResponse,
		req: Partial<Parameters<typeof generateImage>[0]> = {},
	) =>
		generateImage(
			{ modelId: FLUX, prompt: "p", ...req },
			{ getModel: anyModel, generate: async () => resp },
		);

	it("refuses a model outside the menu before any call", async () => {
		const generate = vi.fn<GenerateImagesFn>();
		await expect(
			generateImage(
				{ modelId: "openai/gpt-5-image", prompt: "p" },
				{ getModel: anyModel, generate },
			),
		).rejects.toThrow(/not in the image menu/);
		expect(generate).not.toHaveBeenCalled();
	});

	it("charges the ceiling price, flagged, when no charge or a zero charge is reported", async () => {
		const missing = await run(stubResponse());
		expect(missing).toMatchObject({ costUsd: 0.2, costEstimated: true });
		const zero = await run(
			stubResponse({
				output: [
					{ type: "image", mimeType: "image/png", data: PNG },
					{ type: "image", mimeType: "image/png", data: PNG },
				],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					providerCost: 0,
				} as never,
			}),
		);
		expect(zero).toMatchObject({ costUsd: 0.4, costEstimated: true });
	});

	it("turns a provider error or abort into a thrown error", async () => {
		await expect(
			run(stubResponse({ stopReason: "error", errorMessage: "402 credits" })),
		).rejects.toThrow(/error: 402 credits/);
		await expect(run(stubResponse({ stopReason: "aborted" }))).rejects.toThrow(
			/aborted/,
		);
	});

	it("refuses an empty result and an unexpected image type", async () => {
		await expect(
			run(
				stubResponse({ output: [{ type: "text", text: "cannot draw that" }] }),
			),
		).rejects.toThrow(/returned no image: cannot draw that/);
		await expect(
			run(
				stubResponse({
					output: [{ type: "image", mimeType: "image/gif", data: PNG }],
				}),
			),
		).rejects.toThrow(/unexpected image type image\/gif/);
	});

	it("passes the caller's abort signal to the provider call", async () => {
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		await generateImage(
			{ modelId: FLUX, prompt: "p", signal: controller.signal },
			{
				getModel: anyModel,
				generate: async (_m, _c, o) => {
					seen = o?.signal;
					return stubResponse();
				},
			},
		);
		expect(seen?.aborted).toBe(false);
		controller.abort();
		expect(seen?.aborted).toBe(true);
	});
});

describe("validateReferences", () => {
	it("caps the count, the type and the size of reference images", () => {
		const ok = { mimeType: "image/png", data: PNG };
		expect(() => validateReferences([ok])).not.toThrow();
		expect(() =>
			validateReferences(Array(MAX_REFERENCE_IMAGES + 1).fill(ok)),
		).toThrow(/At most/);
		expect(() =>
			validateReferences([{ mimeType: "image/svg+xml", data: PNG }]),
		).toThrow(/not accepted/);
		expect(() =>
			validateReferences([
				{ mimeType: "image/png", data: "A".repeat(8 * 1024 * 1024) },
			]),
		).toThrow(/too large/);
	});
});

describe("chargeFor", () => {
	it("ignores a non-finite or negative reported charge", () => {
		expect(chargeFor(Number.NaN, 0.1, 1)).toEqual({
			costUsd: 0.1,
			costEstimated: true,
		});
		expect(chargeFor(-1, 0.1, 2)).toEqual({
			costUsd: 0.2,
			costEstimated: true,
		});
		expect(chargeFor(0.05, 0.1, 1)).toEqual({
			costUsd: 0.05,
			costEstimated: false,
		});
	});
});

describe("image metering", () => {
	const result: GenerateImageResult = {
		modelId: FLUX,
		images: [{ mimeType: "image/png", bytes: Buffer.from(PNG, "base64") }],
		costUsd: 0.2,
		costEstimated: true,
		tokens: { input: 10, output: 0 },
	};

	it("logs the fixed cost through the log-only meter, flagged as estimated", async () => {
		const appended: Array<{
			model: string;
			costEstimated: boolean;
			usage: { cost: { totalCostUsd: number } };
		}> = [];
		const charged: number[] = [];
		await createLogOnlyMeter(
			{ append: async (e) => void appended.push(e as never) },
			"m1",
			"designer",
			async (c) => void charged.push(c),
		)(imageMeterEvent(result, "a fern"));
		expect(appended[0].model).toBe(FLUX);
		expect(appended[0].costEstimated).toBe(true);
		expect(appended[0].usage.cost.totalCostUsd).toBe(0.2);
		expect(charged).toEqual([0.2]);
	});

	it("charges the turn's statistics with the fixed cost through the per-turn hook", async () => {
		const recorded: number[] = [];
		const hook = createLlmCallHook(
			{
				model: CLAUDE_HAIKU,
				statsCollector: {
					recordLlmCall: async (_a: string, s: { costUsd: number }) =>
						void recorded.push(s.costUsd),
				} as never,
			},
			"m1",
			"designer",
		)(3, false);
		await hook?.(imageMeterEvent({ ...result, costEstimated: false }, "p"));
		expect(recorded).toEqual([0.2]);
	});
});
