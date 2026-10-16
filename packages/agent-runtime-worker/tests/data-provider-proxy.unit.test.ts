/**
 * Unit tests for the FRED/FMP/NewsAPI server-side proxy tools (issue CR-04,
 * job-env half). No network — the pinned fetch layer (safe-http.ts) is mocked
 * and asserted on.
 *
 * These tools exist so background jobs (agent-authored code) never receive
 * the raw provider keys in their own env — the daemon holds the key, the job
 * calls the tool through the loopback ToolApiServer instead. The core
 * property under test: the constructed request always carries the real key
 * server-side, and the raw response text passes through unmodified (the
 * Python adapters keep doing their own JSON parsing / CSV writing).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/safe-http.js", () => ({ safeGet: vi.fn() }));

import { safeGet } from "../src/safe-http.js";
import {
	DailyQuota,
	tryCreateDataFmpTool,
	tryCreateDataFredTool,
	tryCreateDataNewsapiTool,
} from "../src/tools/data-provider-proxy.js";

const ORIGINAL_ENV = { ...process.env };

function stubFetch(status: number, body: string) {
	const mock = vi.mocked(safeGet);
	mock.mockReset();
	mock.mockImplementation(async (input) => ({
		status,
		headers: {},
		bytes: Buffer.from(body),
		finalUrl: typeof input === "string" ? new URL(input) : input,
	}));
	return mock;
}

beforeEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
	vi.mocked(safeGet).mockReset();
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
		process.env.NEWSAPIORG_API_KEY ??= "k";
		process.env.NEWSAPIORG_API_KEY = "secret-news-key";
		const fetchMock = stubFetch(200, '{"status":"ok","articles":[]}');
		const tool = tryCreateDataNewsapiTool();

		await tool?.execute("id", { q: "NVIDIA", pageSize: 500 }, undefined);

		const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
		expect(calledUrl.searchParams.get("q")).toBe("NVIDIA");
		expect(calledUrl.searchParams.get("pageSize")).toBe("100");
		expect(calledUrl.searchParams.get("apiKey")).toBe("secret-news-key");
	});
});

describe("data-newsapi query", () => {
	it("requires q instead of defaulting to a hard-coded query", async () => {
		process.env.NEWSAPIORG_API_KEY = "k";
		const mock = stubFetch(200, "{}");
		const tool = tryCreateDataNewsapiTool();
		const result = await tool?.execute("id", {}, undefined);
		expect(result?.isError).toBe(true);
		expect(mock).not.toHaveBeenCalled();
	});
});

describe("DailyQuota", () => {
	it("caps calls per provider per UTC day and resets on the next day", () => {
		let now = new Date("2026-10-17T10:00:00Z");
		const q = new DailyQuota(2, () => now);
		expect(q.take("fred")).toBe(true);
		expect(q.take("fred")).toBe(true);
		expect(q.take("fred")).toBe(false);
		expect(q.take("fmp")).toBe(true); // independent per provider
		expect(q.used("fred")).toBe(2);
		now = new Date("2026-10-18T00:00:01Z");
		expect(q.take("fred")).toBe(true);
		expect(q.used("fred")).toBe(1);
	});
});
