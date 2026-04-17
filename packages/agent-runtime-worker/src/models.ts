import { getModel } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";

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
			cacheRead: opts.cacheReadCostPerMillion ?? (opts.inputCostPerMillion ?? 3) * 0.1,
			cacheWrite: opts.cacheWriteCostPerMillion ?? (opts.inputCostPerMillion ?? 3) * 1.25,
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
export const MINISTRAL_14B = getModel("openrouter", "mistralai/ministral-14b-2512");

/**
 * Resolve a model ID string to a Model object.
 * IDs containing "/" are looked up as OpenRouter models (e.g. "deepseek/deepseek-v3.2").
 * All other IDs are treated as Anthropic Claude models.
 */
export function parseModel(id: string): Model<string> {
	if (id.includes("/")) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const m = getModel("openrouter", id as any);
		if (!m) throw new Error(`Unknown OpenRouter model: "${id}"`);
		return m;
	}
	return anthropicModel(id);
}
