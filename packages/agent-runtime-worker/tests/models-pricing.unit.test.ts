/**
 * Every first-party model the platform offers is priced from its own entry,
 * never from the generic fallback (which prices an unknown id at Sonnet
 * rates). The cockpit's model picker shows these same prices.
 */
import { describe, expect, it } from "vitest";
import { KNOWN_ANTHROPIC_MODEL_IDS, resolveModel } from "../src/models.js";

describe("first-party model pricing", () => {
	it("Opus is priced at its own rates, not Sonnet's", () => {
		const opus = resolveModel("claude-opus-4-8");
		expect(opus.cost.input).toBe(5);
		expect(opus.cost.output).toBe(25);
		expect(opus.contextWindow).toBe(1_000_000);
	});

	it("every known Anthropic id resolves to a distinct, explicit entry", () => {
		const sonnet = resolveModel("claude-sonnet-4-6");
		for (const id of KNOWN_ANTHROPIC_MODEL_IDS) {
			const m = resolveModel(id);
			expect(m.id).toBe(id);
			if (id !== sonnet.id) expect(m.cost).not.toEqual(sonnet.cost);
		}
	});
});
