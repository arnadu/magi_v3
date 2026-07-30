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
