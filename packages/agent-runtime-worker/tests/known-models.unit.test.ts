import { describe, expect, it } from "vitest";
import {
	assertKnownModels,
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

	it("on an edit, refuses only ids that differ from the stored config (#86)", () => {
		const stored = {
			model: "claude-retired-1",
			visionModel: "retired/vision-v0",
		};
		expect(unknownModelIds(stored, stored)).toEqual([]);
		expect(
			unknownModelIds({ ...stored, visionModel: "nope/model" }, stored),
		).toEqual(["nope/model"]);
		expect(unknownModelIds(stored)).toEqual([
			"claude-retired-1",
			"retired/vision-v0",
		]);
	});

	it("names the offending field in the refusal", () => {
		expect(() => assertKnownModels({ visionModel: "nope/model" })).toThrow(
			/mission\.visionModel: unknown model id "nope\/model"/,
		);
	});
});
