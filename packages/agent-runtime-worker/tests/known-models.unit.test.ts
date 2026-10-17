import { describe, expect, it } from "vitest";
import {
	isKnownModelId,
	KNOWN_ANTHROPIC_MODEL_IDS,
	unknownModelIds,
} from "../src/models.js";

describe("known model ids (MD1)", () => {
	it("accepts the platform's Anthropic ids and registry OpenRouter ids, rejects the rest", () => {
		for (const id of KNOWN_ANTHROPIC_MODEL_IDS)
			expect(isKnownModelId(id)).toBe(true);
		expect(isKnownModelId("claude-sonnet-9-9")).toBe(false);
		expect(isKnownModelId("deepseek/deepseek-chat")).toBe(true);
		expect(isKnownModelId("someone/made-this-up-v0")).toBe(false);
	});

	it("lists the unknown ids a config names, so the caller can refuse it", () => {
		expect(unknownModelIds({})).toEqual([]);
		expect(
			unknownModelIds({
				model: "deepseek/deepseek-chat",
				visionModel: "nope/model",
			}),
		).toEqual(["nope/model"]);
	});
});
