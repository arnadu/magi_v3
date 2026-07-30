/**
 * Issue #10 (Track 2): resolveCallCost prefers the provider-reported cost
 * (OpenRouter's usage.cost, surfaced by the patched pi-ai as
 * AssistantMessage.usage.providerCost — ADR-0023) over the static-price-table
 * estimate.
 */

import { describe, expect, it } from "vitest";
import type { LlmCallCost } from "../src/llm-call-log.js";
import { resolveCallCost } from "../src/llm-call-log.js";

const estimatedCost: LlmCallCost = {
	inputCostUsd: 0.003,
	outputCostUsd: 0.015,
	cacheReadCostUsd: 0,
	cacheWriteCostUsd: 0,
	totalCostUsd: 0.018,
};

describe("resolveCallCost", () => {
	it("anthropic: costEstimated is false and the static total is used (list prices are exact)", () => {
		const { cost, costEstimated } = resolveCallCost(
			estimatedCost,
			"anthropic",
			undefined,
		);
		expect(costEstimated).toBe(false);
		expect(cost.totalCostUsd).toBe(0.018);
	});

	it("openrouter with providerCost: costEstimated is false and totalCostUsd is overridden", () => {
		const { cost, costEstimated } = resolveCallCost(
			estimatedCost,
			"openrouter",
			0.0234,
		);
		expect(costEstimated).toBe(false);
		expect(cost.totalCostUsd).toBe(0.0234);
		// Per-component breakdown stays the static estimate — OpenRouter reports
		// one total figure, not a per-component split.
		expect(cost.inputCostUsd).toBe(0.003);
		expect(cost.outputCostUsd).toBe(0.015);
	});

	it("openrouter without providerCost: falls back to the static estimate, costEstimated is true", () => {
		const { cost, costEstimated } = resolveCallCost(
			estimatedCost,
			"openrouter",
			undefined,
		);
		expect(costEstimated).toBe(true);
		expect(cost.totalCostUsd).toBe(0.018);
	});

	it("a provider other than anthropic/openrouter without providerCost is also treated as estimated", () => {
		const { costEstimated } = resolveCallCost(
			estimatedCost,
			"google",
			undefined,
		);
		expect(costEstimated).toBe(true);
	});
});
