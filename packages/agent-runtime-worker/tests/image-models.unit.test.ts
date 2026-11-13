import { builtinImagesModels } from "@mariozechner/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import {
	IMAGE_KINDS,
	IMAGE_MENU,
	IMAGE_TIERS,
	imageMenuEntry,
	resolveImageModel,
} from "../src/images/image-models.js";

describe("image menu validation (ADR-0035 decision 9)", () => {
	const registry = builtinImagesModels();

	it("names only models in pi-ai's image registry, on OpenRouter's images API", () => {
		for (const entry of IMAGE_MENU) {
			const model = registry.getModel("openrouter", entry.id);
			expect(model, entry.id).toBeDefined();
			expect(model?.api).toBe("openrouter-images");
		}
	});

	it("gives every entry a finite ceiling price above zero, and never openrouter/auto", () => {
		for (const entry of IMAGE_MENU) {
			expect(Number.isFinite(entry.ceilingUsdPerImage), entry.id).toBe(true);
			expect(entry.ceilingUsdPerImage, entry.id).toBeGreaterThan(0);
			expect(entry.id).not.toMatch(/^openrouter\//);
		}
	});

	it("has no duplicate ids and serves every kind at every tier", () => {
		const ids = IMAGE_MENU.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const kind of IMAGE_KINDS)
			for (const tier of IMAGE_TIERS)
				expect(resolveImageModel(kind, tier).kind).toBe(kind);
	});
});

describe("resolveImageModel", () => {
	it("picks the draft and final models of a kind", () => {
		expect(resolveImageModel("vector", "draft").id).toBe(
			"recraft/recraft-v4.1-vector",
		);
		expect(resolveImageModel("vector", "final").id).toBe(
			"recraft/recraft-v4.1-pro-vector",
		);
		expect(resolveImageModel("vector", "final").output).toBe("svg");
	});

	it("refuses a kind the mission did not enable", () => {
		expect(() => resolveImageModel("vector", "draft", ["raster-art"])).toThrow(
			/not enabled for this mission/,
		);
		expect(resolveImageModel("raster-art", "draft", ["raster-art"]).id).toBe(
			"black-forest-labs/flux.2-pro",
		);
	});

	it("looks entries up by id", () => {
		expect(imageMenuEntry("google/gemini-3-pro-image")?.kind).toBe(
			"raster-instruct",
		);
		expect(imageMenuEntry("openai/gpt-5-image")).toBeUndefined();
	});
});
