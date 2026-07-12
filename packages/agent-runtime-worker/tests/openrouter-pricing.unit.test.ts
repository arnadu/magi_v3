import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
	applyPricingToModel,
	catalogFromModelsResponse,
	pricingFromModelsResponse,
} from "../src/openrouter-pricing.js";

// ---------------------------------------------------------------------------
// pricingFromModelsResponse — per-token strings → per-million numbers
// ---------------------------------------------------------------------------

describe("pricingFromModelsResponse", () => {
	it("converts per-token prices to per-million", () => {
		const map = pricingFromModelsResponse({
			data: [
				{
					id: "deepseek/deepseek-v3.2",
					pricing: { prompt: "0.00000025", completion: "0.00000038" },
				},
			],
		});
		const p = map.get("deepseek/deepseek-v3.2");
		expect(p?.input).toBeCloseTo(0.25, 10);
		expect(p?.output).toBeCloseTo(0.38, 10);
	});

	it("defaults cache prices to the input price when not reported", () => {
		const map = pricingFromModelsResponse({
			data: [
				{ id: "x/y", pricing: { prompt: "0.000001", completion: "0.000002" } },
			],
		});
		const p = map.get("x/y");
		expect(p?.cacheRead).toBeCloseTo(1, 10); // == input, not 0
		expect(p?.cacheWrite).toBeCloseTo(1, 10);
	});

	it("maps explicit cache prices when present", () => {
		const map = pricingFromModelsResponse({
			data: [
				{
					id: "a/b",
					pricing: {
						prompt: "0.000003",
						completion: "0.000015",
						input_cache_read: "0.0000003",
						input_cache_write: "0.00000375",
					},
				},
			],
		});
		const p = map.get("a/b");
		expect(p?.cacheRead).toBeCloseTo(0.3, 10);
		expect(p?.cacheWrite).toBeCloseTo(3.75, 10);
	});

	it("skips models without usable prompt/completion prices", () => {
		const map = pricingFromModelsResponse({
			data: [
				{ id: "no-pricing" },
				{ id: "partial", pricing: { prompt: "0.000001" } },
				{ id: "bad", pricing: { prompt: "abc", completion: "0.000002" } },
				{ pricing: { prompt: "0.000001", completion: "0.000002" } }, // no id
			],
		});
		expect(map.size).toBe(0);
	});

	it("tolerates a missing data array", () => {
		expect(pricingFromModelsResponse({}).size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// catalogFromModelsResponse — full model list for a picker UI (GitHub #18)
// ---------------------------------------------------------------------------

describe("catalogFromModelsResponse", () => {
	it("keeps id, name, context length, and pricing", () => {
		const catalog = catalogFromModelsResponse({
			data: [
				{
					id: "z-ai/glm-5.2",
					name: "GLM 5.2",
					context_length: 128_000,
					pricing: { prompt: "0.0000006", completion: "0.0000022" },
				},
			],
		});
		expect(catalog).toEqual([
			{
				id: "z-ai/glm-5.2",
				name: "GLM 5.2",
				contextLength: 128_000,
				supportsVision: false,
				pricing: { input: 0.6, output: 2.2, cacheRead: 0.6, cacheWrite: 0.6 },
			},
		]);
	});

	it("falls back to id as name when name is absent", () => {
		const [m] = catalogFromModelsResponse({ data: [{ id: "x/y" }] });
		expect(m.name).toBe("x/y");
	});

	it("detects vision support from architecture.input_modalities", () => {
		const [vision] = catalogFromModelsResponse({
			data: [
				{
					id: "a/b",
					architecture: { input_modalities: ["text", "image"] },
				},
			],
		});
		expect(vision.supportsVision).toBe(true);

		const [textOnly] = catalogFromModelsResponse({
			data: [{ id: "c/d", architecture: { input_modalities: ["text"] } }],
		});
		expect(textOnly.supportsVision).toBe(false);
	});

	it("keeps a model with no usable pricing, with pricing left undefined", () => {
		const [m] = catalogFromModelsResponse({
			data: [{ id: "no-price", pricing: { prompt: "abc" } }],
		});
		expect(m.id).toBe("no-price");
		expect(m.pricing).toBeUndefined();
	});

	it("skips entries with no id", () => {
		expect(catalogFromModelsResponse({ data: [{ name: "no id" }] })).toEqual(
			[],
		);
	});

	it("tolerates a missing data array", () => {
		expect(catalogFromModelsResponse({})).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// applyPricingToModel — overwrite cost in place, only for OpenRouter
// ---------------------------------------------------------------------------

function model(provider: string, id: string): Model<string> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example",
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_096,
	} as Model<string>;
}

describe("applyPricingToModel", () => {
	const pricing = new Map([
		[
			"deepseek/deepseek-v3.2",
			{ input: 0.25, output: 0.38, cacheRead: 0.25, cacheWrite: 0.25 },
		],
	]);

	it("overwrites the cost block for a known OpenRouter slug", () => {
		const m = model("openrouter", "deepseek/deepseek-v3.2");
		expect(applyPricingToModel(m, pricing)).toBe(true);
		expect(m.cost.input).toBe(0.25);
		expect(m.cost.output).toBe(0.38);
		expect(m.cost.cacheRead).toBe(0.25); // no longer the 0 fallback
	});

	it("is a no-op for non-OpenRouter providers", () => {
		const m = model("anthropic", "deepseek/deepseek-v3.2");
		expect(applyPricingToModel(m, pricing)).toBe(false);
		expect(m.cost.input).toBe(3); // untouched
	});

	it("is a no-op when the slug is not in the map", () => {
		const m = model("openrouter", "unknown/slug");
		expect(applyPricingToModel(m, pricing)).toBe(false);
		expect(m.cost.input).toBe(3);
	});
});
