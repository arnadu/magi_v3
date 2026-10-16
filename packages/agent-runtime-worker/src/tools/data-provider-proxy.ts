/**
 * Server-side proxies for FRED / FMP / NewsAPI (issue CR-04, job-env half).
 *
 * Background jobs are agent-authored code; a reusable third-party credential
 * in their environment could be read and exfiltrated with no privilege
 * escalation. So the daemon keeps the real keys in its own env (never
 * forwarded to job spawns — see job-runner.ts) and job code calls these tools
 * through the loopback ToolApiServer (bearer-token-scoped, revocable per job).
 * A job gets a capability ("fetch me this FRED series"), never the credential.
 *
 * Each tool reproduces the request the corresponding
 * `packages/skills/data-factory` Python adapter used to build itself — same
 * base URL, same param names — so the adapters only swap "build URL with key,
 * urlopen it" for "call this tool, urlopen the response".
 *
 * Because any token holder can call these, the daemon also owns the budget:
 * a per-provider daily call cap (`DATA_PROVIDER_DAILY_CAP`, default 500,
 * UTC day) that no agent-writable counter file can reset, a response size
 * cap, and upstream error bodies are not echoed (they can contain the key in
 * a URL).
 *
 * Returns `null` when the corresponding key isn't configured — these tools are
 * internal plumbing for the data-factory skill, not agent-facing.
 */

import { Type } from "@sinclair/typebox";
import { safeGet } from "../safe-http.js";
import type { MagiTool, ToolResult } from "../tools.js";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function ok(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

function toolErr(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

/** Daily calls allowed per provider (UTC day), enforced in the daemon. */
export function dailyCap(env: NodeJS.ProcessEnv = process.env): number {
	const n = Number.parseInt(env.DATA_PROVIDER_DAILY_CAP ?? "", 10);
	return Number.isInteger(n) && n > 0 ? n : 500;
}

/** In-memory per-provider counter keyed by UTC date; resets when the date changes. */
export class DailyQuota {
	private day = "";
	private readonly counts = new Map<string, number>();
	constructor(
		private readonly cap: number,
		private readonly now: () => Date = () => new Date(),
	) {}
	/** Reserve one call; false when the provider's cap for today is exhausted. */
	take(provider: string): boolean {
		const today = this.now().toISOString().slice(0, 10);
		if (today !== this.day) {
			this.day = today;
			this.counts.clear();
		}
		const used = this.counts.get(provider) ?? 0;
		if (used >= this.cap) return false;
		this.counts.set(provider, used + 1);
		return true;
	}
	used(provider: string): number {
		return this.counts.get(provider) ?? 0;
	}
}

const quota = new DailyQuota(dailyCap());

async function providerGet(provider: string, url: string): Promise<ToolResult> {
	if (!quota.take(provider)) {
		return toolErr(
			`${provider}: daily call cap (${dailyCap()}) reached for this machine — try again after 00:00 UTC, or ask the operator to raise DATA_PROVIDER_DAILY_CAP`,
		);
	}
	try {
		const res = await safeGet(url, {
			maxBytes: MAX_RESPONSE_BYTES,
			timeoutMs: FETCH_TIMEOUT_MS,
		});
		if (res.status < 200 || res.status >= 300) {
			// The body is not echoed: provider errors quote the request URL,
			// which carries the key.
			return toolErr(`upstream returned ${res.status}`);
		}
		return ok(res.bytes.toString("utf8"));
	} catch (e) {
		return toolErr(`request failed: ${(e as Error).message}`);
	}
}

export function tryCreateDataFredTool(): MagiTool | null {
	const apiKey = process.env.FRED_API_KEY;
	if (!apiKey) return null;
	return {
		name: "data-fred",
		description:
			"Internal — fetches raw FRED observations JSON for a series. " +
			"Used by the data-factory FRED adapter; not agent-facing.",
		parameters: Type.Object({
			seriesId: Type.String(),
			observationStart: Type.String(),
		}),
		async execute(_id, rawArgs) {
			const { seriesId, observationStart } = rawArgs as {
				seriesId: string;
				observationStart: string;
			};
			const params = new URLSearchParams({
				series_id: seriesId,
				api_key: apiKey,
				file_type: "json",
				observation_start: observationStart,
				sort_order: "asc",
			});
			return providerGet(
				"fred",
				`https://api.stlouisfed.org/fred/series/observations?${params}`,
			);
		},
	};
}

export function tryCreateDataFmpTool(): MagiTool | null {
	const apiKey = process.env.FMP_API_KEY;
	if (!apiKey) return null;
	const FMP_API = "https://financialmodelingprep.com/api/v3";
	return {
		name: "data-fmp",
		description:
			"Internal — fetches raw FMP OHLCV or SEC-filings JSON for a ticker. " +
			"Used by the data-factory FMP adapter; not agent-facing.",
		parameters: Type.Object({
			ticker: Type.String(),
			type: Type.Union([Type.Literal("daily"), Type.Literal("sec_filings")]),
		}),
		async execute(_id, rawArgs) {
			const { ticker, type } = rawArgs as {
				ticker: string;
				type: "daily" | "sec_filings";
			};
			const url =
				type === "daily"
					? `${FMP_API}/historical-price-full/${encodeURIComponent(ticker)}?apikey=${apiKey}`
					: `${FMP_API}/sec_filings/${encodeURIComponent(ticker)}?type=&apikey=${apiKey}`;
			return providerGet("fmp", url);
		},
	};
}

export function tryCreateDataNewsapiTool(): MagiTool | null {
	const apiKey = process.env.NEWSAPIORG_API_KEY;
	if (!apiKey) return null;
	return {
		name: "data-newsapi",
		description:
			"Internal — fetches raw NewsAPI.org articles JSON for a query. " +
			"Used by the data-factory NewsAPI adapter; not agent-facing.",
		parameters: Type.Object({
			q: Type.String(),
			language: Type.Optional(Type.String()),
			pageSize: Type.Optional(Type.Number()),
			sortBy: Type.Optional(Type.String()),
		}),
		async execute(_id, rawArgs) {
			const args = rawArgs as {
				q?: string;
				language?: string;
				pageSize?: number;
				sortBy?: string;
			};
			if (!args.q || !args.q.trim()) {
				return toolErr("data-newsapi: q (the search query) is required");
			}
			const params = new URLSearchParams({
				q: args.q,
				language: args.language ?? "en",
				pageSize: String(Math.min(args.pageSize ?? 20, 100)),
				sortBy: args.sortBy ?? "publishedAt",
				apiKey,
			});
			return providerGet(
				"newsapi",
				`https://newsapi.org/v2/everything?${params}`,
			);
		},
	};
}
