/**
 * Server-side proxies for FRED / FMP / NewsAPI (issue CR-04, job-env half).
 *
 * Previously, `daemon.ts`'s `dataKeysEnv()` spread the raw
 * FRED_API_KEY/FMP_API_KEY/NEWSAPIORG_API_KEY directly into every background
 * job's environment — agent-authored code (a job's own script, submitted via
 * the run-background skill) could read and exfiltrate a reusable third-party
 * credential with no privilege escalation needed. These tools replace that:
 * the daemon keeps holding the real keys (only in its own env, never
 * forwarded to job spawns — see `runPendingJobs` in daemon.ts), and job code
 * calls these through the existing loopback ToolApiServer (already
 * bearer-token-scoped and revocable per job) instead. A job gets a
 * capability ("fetch me this FRED series"), never the credential itself.
 *
 * Each tool reproduces exactly the request the corresponding
 * `packages/skills/data-factory` Python adapter used to build itself —
 * same base URL, same param names, same provider — so the adapters only
 * need to swap "build URL with key, urlopen it" for "call this tool,
 * urlopen the response"; their own JSON parsing / CSV writing / date
 * filtering is unchanged.
 *
 * Returns `null` when the corresponding key isn't configured (mirrors
 * `tryCreateSearchWebTool`'s conditional-registration pattern) — these
 * tools are internal plumbing for the data-factory skill, not agent-facing
 * (not part of the interactive tool list; only reachable via ToolApiServer).
 */

import { Type } from "@sinclair/typebox";
import type { MagiTool, ToolResult } from "../tools.js";

const FETCH_TIMEOUT_MS = 30_000;

function ok(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

function toolErr(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

async function getText(url: string): Promise<ToolResult> {
	let res: Response;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (e) {
		return toolErr(`request failed: ${(e as Error).message}`);
	}
	const text = await res.text();
	if (!res.ok) return toolErr(`upstream returned ${res.status}: ${text}`);
	return ok(text);
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
			return getText(
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
			return getText(url);
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
			q: Type.Optional(Type.String()),
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
			const params = new URLSearchParams({
				q: args.q ?? "NVIDIA",
				language: args.language ?? "en",
				pageSize: String(Math.min(args.pageSize ?? 20, 100)),
				sortBy: args.sortBy ?? "publishedAt",
				apiKey,
			});
			return getText(`https://newsapi.org/v2/everything?${params}`);
		},
	};
}
