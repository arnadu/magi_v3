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
			cacheRead: 0,
			cacheWrite: 0,
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
