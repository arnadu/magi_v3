/**
 * Issue #10 (Track 2): resolveCallCost prefers the provider-reported cost
 * (OpenRouter's usage.cost, surfaced by the patched pi-ai as
 * AssistantMessage.usage.providerCost — ADR-0023) over the static-price-table
 * estimate.
 */

import type { Message, UserMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { LlmCallCost } from "../src/llm-call-log.js";
import { resolveCallCost, truncateOldMessages } from "../src/llm-call-log.js";

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

function userMsg(i: number): UserMessage {
	return { role: "user", content: `message ${i}`, timestamp: i };
}

describe("truncateOldMessages", () => {
	it("passes a short array through unchanged", () => {
		const messages: Message[] = [userMsg(0), userMsg(1), userMsg(2)];
		expect(truncateOldMessages(messages)).toBe(messages);
	});

	it("caps a long array to the most recent 40, prepending a count marker", () => {
		const messages: Message[] = Array.from({ length: 50 }, (_, i) =>
			userMsg(i),
		);
		const result = truncateOldMessages(messages);
		expect(result).toHaveLength(41); // marker + last 40
		const marker = result[0] as UserMessage;
		expect(marker.role).toBe("user");
		expect(marker.content).toContain("10 earlier message(s) omitted");
		// The kept tail is exactly the last 40 original messages, in order.
		expect(result.slice(1)).toEqual(messages.slice(-40));
	});

	it("is exactly at the cap: no marker inserted", () => {
		const messages: Message[] = Array.from({ length: 40 }, (_, i) =>
			userMsg(i),
		);
		const result = truncateOldMessages(messages);
		expect(result).toHaveLength(40);
		expect(result).toBe(messages);
	});
});
