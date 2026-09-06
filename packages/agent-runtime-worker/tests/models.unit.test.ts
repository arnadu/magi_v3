/**
 * OpenRouter caching investigation (issue #24): every OpenRouter Model MAGI
 * builds must set compat.sendSessionAffinityHeaders — pi-ai defaults this to
 * false for every provider, so without it, options.sessionId (loop.ts) is
 * silently ignored and OpenRouter's own sticky-routing guarantee (x-session-id)
 * never gets sent, even though pi-ai already auto-detects the correct header
 * format for OpenRouter.
 */

import { describe, expect, it } from "vitest";
import { DEEPSEEK_V3_2, MINISTRAL_14B, parseModel } from "../src/models.js";

describe("OpenRouter models carry sendSessionAffinityHeaders", () => {
	it("DEEPSEEK_V3_2 (getBuiltinModel-sourced)", () => {
		expect(DEEPSEEK_V3_2.compat?.sendSessionAffinityHeaders).toBe(true);
		expect(DEEPSEEK_V3_2.provider).toBe("openrouter");
	});

	it("MINISTRAL_14B (getBuiltinModel-sourced)", () => {
		expect(MINISTRAL_14B.compat?.sendSessionAffinityHeaders).toBe(true);
		expect(MINISTRAL_14B.provider).toBe("openrouter");
	});

	it("parseModel: a registry-hit OpenRouter slug", () => {
		const model = parseModel("deepseek/deepseek-v3.2");
		expect(model.compat?.sendSessionAffinityHeaders).toBe(true);
	});

	it("parseModel: an OpenRouter slug not in the pre-generated registry (fallback descriptor)", () => {
		const model = parseModel("z-ai/glm-5.2");
		expect(model.provider).toBe("openrouter");
		expect(model.compat?.sendSessionAffinityHeaders).toBe(true);
	});

	it("parseModel: a plain Anthropic id is untouched — no compat override", () => {
		const model = parseModel("claude-sonnet-4-6");
		expect(model.provider).toBe("anthropic");
		expect(model.compat).toBeUndefined();
	});
});

describe("parseModel: vision-capable fallback for unregistered OpenRouter ids (issue #40)", () => {
	it("a registry-hit model keeps its real capability data, not the fallback", () => {
		// deepseek-v3.2 is text-only in the registry — confirms the fallback
		// logic below is not accidentally short-circuiting registry hits.
		const model = parseModel("deepseek/deepseek-v3.2");
		expect(model.input).not.toContain("image");
	});

	it("grants image support to unregistered anthropic/* ids (still, for back-compat)", () => {
		const model = parseModel("anthropic/claude-9000-hypothetical");
		expect(model.input).toContain("image");
	});

	it("grants image support to unregistered known-vision-family ids", () => {
		expect(parseModel("google/gemini-9.9-hypothetical").input).toContain(
			"image",
		);
		expect(parseModel("openai/gpt-4o-hypothetical").input).toContain("image");
		expect(parseModel("mistralai/pixtral-hypothetical").input).toContain(
			"image",
		);
	});

	it("does not grant image support to an unregistered text-only-family id", () => {
		// The exact bug from issue #40: an unregistered non-Anthropic model
		// used to always fall back to text-only, silently disabling image
		// auto-description even for a real vision model. This case (a
		// genuinely unlisted, unknown vendor) should still default to
		// text-only — the fix is precision (known families), not a blanket
		// default of true.
		const model = parseModel("some-new-vendor/text-model-v1");
		expect(model.input).not.toContain("image");
	});
});
