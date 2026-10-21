import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const modelsResponse = (id: string) => ({
	data: [
		{
			id,
			name: id,
			context_length: 1000,
			pricing: { prompt: "0.000001", completion: "0.000002" },
			architecture: { input_modalities: ["text"] },
		},
	],
});

async function freshModule() {
	vi.resetModules();
	return import("../src/openrouter-pricing.js");
}

describe("OpenRouter model-list cache (OP1)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("reuses the list within the TTL and refetches after it", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json(modelsResponse("a/old")))
			.mockResolvedValueOnce(Response.json(modelsResponse("a/new")));
		vi.stubGlobal("fetch", fetchMock);
		const m = await freshModule();

		expect((await m.fetchOpenRouterCatalog()).map((x) => x.id)).toEqual([
			"a/old",
		]);
		vi.setSystemTime(Date.now() + m.OPENROUTER_CACHE_TTL_MS - 1000);
		expect((await m.fetchOpenRouterCatalog()).map((x) => x.id)).toEqual([
			"a/old",
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		vi.setSystemTime(Date.now() + 2000);
		expect((await m.fetchOpenRouterCatalog()).map((x) => x.id)).toEqual([
			"a/new",
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("keeps serving the previous list when a refetch fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json(modelsResponse("a/old")))
			.mockRejectedValueOnce(new Error("network down"));
		vi.stubGlobal("fetch", fetchMock);
		const m = await freshModule();

		await m.fetchOpenRouterCatalog();
		vi.setSystemTime(Date.now() + m.OPENROUTER_CACHE_TTL_MS + 1000);
		expect((await m.fetchOpenRouterCatalog()).map((x) => x.id)).toEqual([
			"a/old",
		]);
		expect(warn.mock.calls[0][0]).toContain("serving the previous list");
		warn.mockRestore();
	});
});
