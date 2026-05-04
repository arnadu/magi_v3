import type { Model } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";

/**
 * Construct an Anthropic model descriptor.
 * completeSimple reads ANTHROPIC_API_KEY from the environment automatically.
 */
export function anthropicModel(
	id: string,
	opts: {
		contextWindow?: number;
		maxTokens?: number;
		inputCostPerMillion?: number;
		outputCostPerMillion?: number;
		cacheReadCostPerMillion?: number;
		cacheWriteCostPerMillion?: number;
	} = {},
): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: opts.inputCostPerMillion ?? 3,
			output: opts.outputCostPerMillion ?? 15,
			// Anthropic list prices (per million tokens).
			// Cache read = 0.1× input price; cache write = 1.25× input price.
			cacheRead:
				opts.cacheReadCostPerMillion ?? (opts.inputCostPerMillion ?? 3) * 0.1,
			cacheWrite:
				opts.cacheWriteCostPerMillion ?? (opts.inputCostPerMillion ?? 3) * 1.25,
		},
		contextWindow: opts.contextWindow ?? 200_000,
		maxTokens: opts.maxTokens ?? 8_096,
	};
}

/** Claude Sonnet 4.6 — default inner-loop model. */
export const CLAUDE_SONNET = anthropicModel("claude-sonnet-4-6", {
	inputCostPerMillion: 3,
	outputCostPerMillion: 15,
	maxTokens: 16_000,
});

/** Claude Haiku 4.5 — secondary model for vision tasks (image captioning, BrowseWeb). */
export const CLAUDE_HAIKU = anthropicModel("claude-haiku-4-5-20251001", {
	inputCostPerMillion: 0.8,
	outputCostPerMillion: 4,
	maxTokens: 8_096,
});

/** DeepSeek V3.2 via OpenRouter — text-only, strong reasoning, cheap ($0.25/$0.38 per MTok). */
export const DEEPSEEK_V3_2 = getModel("openrouter", "deepseek/deepseek-v3.2");

/** Mistral Ministral 14B 2512 via OpenRouter — text + image, cheap vision model ($0.20/$0.20 per MTok). */
export const MINISTRAL_14B = getModel(
	"openrouter",
	"mistralai/ministral-14b-2512",
);

/**
 * Resolve a well-known model ID to its pre-configured Model constant with accurate
 * cost data. Falls through to parseModel for any ID not explicitly listed.
 * Use this instead of a cascade of if/else in callers.
 */
export function resolveModel(id: string): Model<string> {
	if (id === "claude-sonnet-4-6") return CLAUDE_SONNET;
	if (id === "claude-haiku-4-5-20251001") return CLAUDE_HAIKU;
	return parseModel(id);
}

/**
 * Resolve a model ID string to a Model object.
 * IDs containing "/" are treated as OpenRouter models (e.g. "deepseek/deepseek-v3.2",
 * "anthropic/claude-sonnet-4-6"). IDs without "/" are Anthropic Claude models.
 *
 * For OpenRouter IDs in the pi-ai generated registry, the pre-computed cost and
 * capability data is used. For IDs not in the registry (newly released models or any
 * valid OpenRouter model slug), a descriptor is constructed with default costs
 * ($3/$15 per MTok, 128k context). anthropic/* IDs are assumed to support images;
 * all others default to text-only. Add an explicit constant above to override.
 */
export function parseModel(id: string): Model<string> {
	if (id.includes("/")) {
		// biome-ignore lint/suspicious/noExplicitAny: getModel expects a literal from models.generated; arbitrary IDs require the cast
		const registered = getModel("openrouter", id as any);
		if (registered) return registered;
		// Not in the pre-generated registry — construct a descriptor directly.
		return {
			id,
			name: id,
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: id.startsWith("anthropic/") ? ["text", "image"] : ["text"],
			cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_096,
		};
	}
	return anthropicModel(id);
}
