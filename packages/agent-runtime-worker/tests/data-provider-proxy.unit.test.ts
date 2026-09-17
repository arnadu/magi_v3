/**
 * Unit tests for the FRED/FMP/NewsAPI server-side proxy tools (issue CR-04,
 * job-env half). No network — global fetch is stubbed and asserted on.
 *
 * These tools exist so background jobs (agent-authored code) never receive
 * the raw provider keys in their own env — the daemon holds the key, the job
 * calls the tool through the loopback ToolApiServer instead. The core
 * property under test: the constructed request always carries the real key
 * server-side, and the raw response text passes through unmodified (the
 * Python adapters keep doing their own JSON parsing / CSV writing).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	tryCreateDataFmpTool,
	tryCreateDataFredTool,
	tryCreateDataNewsapiTool,
} from "../src/tools/data-provider-proxy.js";

const ORIGINAL_ENV = { ...process.env };

function stubFetch(status: number, body: string): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(
		async () => new Response(body, { status, statusText: "" }),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
	vi.unstubAllGlobals();
	process.env = { ...ORIGINAL_ENV };
});

describe("tryCreateDataFredTool", () => {
	it("returns null when FRED_API_KEY is not set", () => {
		delete process.env.FRED_API_KEY;
		expect(tryCreateDataFredTool()).toBeNull();
	});

	it("builds the correct FRED URL with the real key, never exposed to the caller", async () => {
		process.env.FRED_API_KEY = "secret-fred-key";
		const fetchMock = stubFetch(200, '{"observations":[]}');
		const tool = tryCreateDataFredTool();
		expect(tool).not.toBeNull();

		const result = await tool?.execute(
			"id",
			{ seriesId: "GDP", observationStart: "2024-01-01" },
			undefined,
		);

		const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
		expect(calledUrl.origin + calledUrl.pathname).toBe(
			"https://api.stlouisfed.org/fred/series/observations",
		);
		expect(calledUrl.searchParams.get("series_id")).toBe("GDP");
		expect(calledUrl.searchParams.get("api_key")).toBe("secret-fred-key");
		expect(calledUrl.searchParams.get("observation_start")).toBe("2024-01-01");
		expect(result?.isError).toBeFalsy();
		expect(result?.content[0]?.text).toBe('{"observations":[]}');
	});

	it("returns an error result on a non-ok upstream response", async () => {
		process.env.FRED_API_KEY = "secret-fred-key";
		stubFetch(500, "internal error");
		const tool = tryCreateDataFredTool();
		const result = await tool?.execute(
			"id",
			{ seriesId: "GDP", observationStart: "2024-01-01" },
			undefined,
		);
		expect(result?.isError).toBe(true);
	});
});

describe("tryCreateDataFmpTool", () => {
	it("returns null when FMP_API_KEY is not set", () => {
		delete process.env.FMP_API_KEY;
		expect(tryCreateDataFmpTool()).toBeNull();
	});

	it("builds the OHLCV URL for type=daily", async () => {
		process.env.FMP_API_KEY = "secret-fmp-key";
		const fetchMock = stubFetch(200, "{}");
		const tool = tryCreateDataFmpTool();

		await tool?.execute("id", { ticker: "AAPL", type: "daily" }, undefined);

		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toBe(
			"https://financialmodelingprep.com/api/v3/historical-price-full/AAPL?apikey=secret-fmp-key",
		);
	});

	it("builds the SEC filings URL for type=sec_filings", async () => {
		process.env.FMP_API_KEY = "secret-fmp-key";
		const fetchMock = stubFetch(200, "[]");
		const tool = tryCreateDataFmpTool();

		await tool?.execute(
			"id",
			{ ticker: "AAPL", type: "sec_filings" },
			undefined,
		);

		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toBe(
			"https://financialmodelingprep.com/api/v3/sec_filings/AAPL?type=&apikey=secret-fmp-key",
		);
	});
});

describe("tryCreateDataNewsapiTool", () => {
	it("returns null when NEWSAPIORG_API_KEY is not set", () => {
		delete process.env.NEWSAPIORG_API_KEY;
		expect(tryCreateDataNewsapiTool()).toBeNull();
	});

	it("builds the NewsAPI URL with defaults and caps pageSize at 100", async () => {
		process.env.NEWSAPIORG_API_KEY = "secret-news-key";
		const fetchMock = stubFetch(200, '{"status":"ok","articles":[]}');
		const tool = tryCreateDataNewsapiTool();

		await tool?.execute("id", { pageSize: 500 }, undefined);

		const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
		expect(calledUrl.searchParams.get("q")).toBe("NVIDIA");
		expect(calledUrl.searchParams.get("pageSize")).toBe("100");
		expect(calledUrl.searchParams.get("apiKey")).toBe("secret-news-key");
	});
});
