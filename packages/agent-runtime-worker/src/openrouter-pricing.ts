/**
 * OpenRouter live pricing — Sprint 24 phase 3 (GitHub #10, Track 1).
 *
 * pi-ai computes cost from a static per-model table and never reads the
 * provider-reported cost (see issue #10). For OpenRouter that table is, at best,
 * a snapshot; for slugs not in pi-ai's generated registry it falls back to a
 * hardcoded $3/$15 with zeroed cache pricing — a gross over-estimate for cheap
 * models. This module fetches OpenRouter's published per-model pricing once at
 * startup and overwrites the `cost` block of any OpenRouter `Model`, so the
 * single downstream `computeCost` path (llmCallLog AND agentTurnStats/missionStats)
 * uses accurate list prices.
 *
 * This is still an ESTIMATE — it uses OpenRouter's list price, not the exact
 * amount charged for the upstream that actually served each request (which pi-ai
 * does not surface). Exact per-call cost is tracked as Track 2 on issue #10.
 *
 * No API key required — `/api/v1/models` is public. The URL is constant (not
 * user-influenced), so there is no SSRF surface. Fetch failures are non-fatal:
 * the model keeps whatever cost pi-ai gave it.
 */

import type { Model } from "@mariozechner/pi-ai";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 10_000;

/** Per-million-token prices for one model, mapped from OpenRouter's per-token figures. */
export interface OpenRouterPrice {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Shape of the bits of `/api/v1/models` we consume. */
interface OpenRouterModelsResponse {
	data?: Array<{
		id?: string;
		pricing?: {
			prompt?: string;
			completion?: string;
			input_cache_read?: string;
			input_cache_write?: string;
		};
	}>;
}

/** Parse a per-token price string (e.g. "0.00000025") to a per-million number. */
function perMillion(perToken: string | undefined): number | undefined {
	if (perToken === undefined) return undefined;
	const n = Number.parseFloat(perToken);
	if (!Number.isFinite(n) || n < 0) return undefined;
	return n * 1_000_000;
}

/**
 * Build a slug → price map from a parsed `/api/v1/models` response. Pure.
 * Models without a usable prompt+completion price are skipped. When OpenRouter
 * does not report cache prices, cacheRead/cacheWrite default to the input price
 * (neutral) rather than 0 — never under-counting cache usage.
 */
export function pricingFromModelsResponse(
	json: OpenRouterModelsResponse,
): Map<string, OpenRouterPrice> {
	const map = new Map<string, OpenRouterPrice>();
	for (const m of json.data ?? []) {
		if (!m.id || !m.pricing) continue;
		const input = perMillion(m.pricing.prompt);
		const output = perMillion(m.pricing.completion);
		if (input === undefined || output === undefined) continue;
		map.set(m.id, {
			input,
			output,
			cacheRead: perMillion(m.pricing.input_cache_read) ?? input,
			cacheWrite: perMillion(m.pricing.input_cache_write) ?? input,
		});
	}
	return map;
}

/**
 * Overwrite an OpenRouter model's cost block from a pricing map, in place.
 * No-op for non-OpenRouter models or slugs absent from the map. Returns true
 * when pricing was applied. Pure aside from the in-place mutation.
 */
export function applyPricingToModel(
	model: Model<string>,
	pricing: Map<string, OpenRouterPrice>,
): boolean {
	if (model.provider !== "openrouter") return false;
	const price = pricing.get(model.id);
	if (!price) return false;
	model.cost = {
		input: price.input,
		output: price.output,
		cacheRead: price.cacheRead,
		cacheWrite: price.cacheWrite,
	};
	return true;
}

// ---------------------------------------------------------------------------
// Fetch + in-process cache
// ---------------------------------------------------------------------------

let cache: Map<string, OpenRouterPrice> | null = null;
let inFlight: Promise<Map<string, OpenRouterPrice>> | null = null;

/**
 * Fetch (and cache for the process lifetime) OpenRouter's published pricing.
 * Concurrent callers share one in-flight request. On any failure returns an
 * empty map and leaves the cache unset so a later call can retry.
 */
export async function fetchOpenRouterPricing(): Promise<
	Map<string, OpenRouterPrice>
> {
	if (cache) return cache;
	if (inFlight) return inFlight;

	inFlight = (async () => {
		try {
			const res = await fetch(OPENROUTER_MODELS_URL, {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} ${res.statusText}`);
			}
			const json = (await res.json()) as OpenRouterModelsResponse;
			const map = pricingFromModelsResponse(json);
			cache = map;
			return map;
		} catch (e) {
			console.warn(
				`[openrouter-pricing] failed to fetch live pricing — keeping pi-ai's static estimate: ${(e as Error).message}`,
			);
			return new Map<string, OpenRouterPrice>();
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
}

/**
 * Enrich an OpenRouter model in place with live list pricing. No-op (and no
 * fetch) for non-OpenRouter models so first-party (Anthropic) cost — which is
 * already exact — is untouched. Logs when pricing is applied.
 */
export async function enrichModelPricing(model: Model<string>): Promise<void> {
	if (model.provider !== "openrouter") return;
	const pricing = await fetchOpenRouterPricing();
	if (applyPricingToModel(model, pricing)) {
		console.log(
			`[openrouter-pricing] applied live pricing for ${model.id}: ` +
				`input $${model.cost.input}/MTok, output $${model.cost.output}/MTok`,
		);
	} else {
		console.warn(
			`[openrouter-pricing] no live pricing for "${model.id}" — cost is a pi-ai static estimate (see issue #10)`,
		);
	}
}

/** Test-only: reset the in-process cache so a fresh fetch is performed. */
export function __resetOpenRouterPricingCache(): void {
	cache = null;
	inFlight = null;
}
