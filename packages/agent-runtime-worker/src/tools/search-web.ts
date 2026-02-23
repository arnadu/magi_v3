import { Type } from "@sinclair/typebox";
import type { MagiTool, ToolResult } from "../tools.js";

// ---------------------------------------------------------------------------
// Brave Search API types (subset)
// ---------------------------------------------------------------------------

interface BraveSearchResult {
	title: string;
	url: string;
	description?: string;
}

interface BraveWebResponse {
	web?: {
		results?: BraveSearchResult[];
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

function toolErr(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the SearchWeb tool.
 *
 * Queries the Brave Search API and returns the top results as a formatted list
 * of title, URL, and snippet. Agents can follow up with FetchUrl on any result.
 *
 * The tool is only registered when BRAVE_SEARCH_API_KEY is set. If the key is
 * absent at call time, the tool returns an informative error rather than
 * throwing, so the agent can handle it gracefully.
 *
 * @param apiKey  Brave Search API key (from env). Pass undefined/empty to still
 *                register the tool but have it return a clear error on use.
 */
export function createSearchWebTool(apiKey: string | undefined): MagiTool {
	return {
		name: "SearchWeb",
		description:
			"Search the web using the Brave Search API and return the top results " +
			"(title, URL, and snippet). Use FetchUrl to retrieve the full content of " +
			"any promising result.",
		parameters: Type.Object({
			query: Type.String({
				description: "Search query",
			}),
			count: Type.Optional(
				Type.Number({
					description: "Number of results to return (default: 10, max: 20)",
				}),
			),
		}),

		async execute(_id, args, signal) {
			if (!apiKey) {
				return toolErr(
					"SearchWeb: BRAVE_SEARCH_API_KEY is not set. " +
						"Set this environment variable to enable web search.",
				);
			}

			const query = args.query as string;
			const count = Math.min(
				Math.max(1, (args.count as number | undefined) ?? 10),
				20,
			);

			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(count));

			let data: BraveWebResponse;
			try {
				const res = await fetch(url.toString(), {
					headers: {
						Accept: "application/json",
						"Accept-Encoding": "gzip",
						"X-Subscription-Token": apiKey,
					},
					signal,
				});
				if (!res.ok) {
					return toolErr(
						`SearchWeb: Brave API returned HTTP ${res.status} ${res.statusText}`,
					);
				}
				data = (await res.json()) as BraveWebResponse;
			} catch (e) {
				return toolErr(`SearchWeb: request failed — ${(e as Error).message}`);
			}

			const results = data.web?.results ?? [];
			if (results.length === 0) {
				return ok(`SearchWeb: no results found for "${query}"`);
			}

			const lines = [`Search results for: ${query}`, ""];
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				lines.push(`${i + 1}. ${r.title}`);
				lines.push(`   ${r.url}`);
				if (r.description) lines.push(`   ${r.description}`);
				lines.push("");
			}
			lines.push(`Use FetchUrl with a URL above to retrieve the full page.`);

			return ok(lines.join("\n"));
		},
	};
}

/**
 * Try to create the SearchWeb tool.
 * Returns the tool if BRAVE_SEARCH_API_KEY is set, undefined otherwise.
 * The caller should skip registering the tool when this returns undefined.
 */
export function tryCreateSearchWebTool(): MagiTool | undefined {
	const apiKey = process.env.BRAVE_SEARCH_API_KEY;
	if (!apiKey) return undefined;
	return createSearchWebTool(apiKey);
}
