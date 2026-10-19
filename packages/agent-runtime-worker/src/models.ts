import { createModels, type Model } from "@mariozechner/pi-ai";
import { getBuiltinModel } from "@mariozechner/pi-ai/providers/all";
import { anthropicProvider } from "@mariozechner/pi-ai/providers/anthropic";
import { openrouterProvider } from "@mariozechner/pi-ai/providers/openrouter";

/**
 * Shared Models collection for the two providers MAGI_V3 calls (Anthropic
 * direct, OpenRouter — see VISION_MODEL's accepted providers in CLAUDE.md).
 * Provider auth resolves from ANTHROPIC_API_KEY/OPENROUTER_API_KEY via the
 * environment, same as the old global completeSimple().
 */
export const piModels = createModels();
piModels.setProvider(anthropicProvider());
piModels.setProvider(openrouterProvider());

/**
 * OpenRouter's own sticky-routing guarantee (session_id / x-session-id — see the
 * OpenRouter caching investigation, issue #10/#24) is opt-in in pi-ai:
 * `sendSessionAffinityHeaders` defaults to false for every provider, OpenRouter
 * included, even though pi-ai already auto-detects the correct header format
 * for it. Every OpenRouter Model MAGI builds should carry this — without it,
 * pi-ai never sends the `x-session-id` header even when a caller passes
 * `options.sessionId`.
 */
function withOpenRouterAffinity(
	model: Model<"openai-completions">,
): Model<"openai-completions"> {
	return {
		...model,
		compat: { ...model.compat, sendSessionAffinityHeaders: true },
	};
}

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
		reasoning?: boolean;
	} = {},
): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: opts.reasoning ?? false,
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

/** Claude Sonnet 4.6 — default inner-loop model. Extended thinking enabled. */
export const CLAUDE_SONNET = anthropicModel("claude-sonnet-4-6", {
	inputCostPerMillion: 3,
	outputCostPerMillion: 15,
	maxTokens: 32_000, // raised from 16k to give pi-ai room for thinking budget + text output
	reasoning: true,
});

/** Claude Opus 4.8 — offered in the model picker; 1M-token context. */
export const CLAUDE_OPUS = anthropicModel("claude-opus-4-8", {
	inputCostPerMillion: 5,
	outputCostPerMillion: 25,
	contextWindow: 1_000_000,
	maxTokens: 32_000,
	reasoning: true,
});

/** Claude Haiku 4.5 — secondary model for vision tasks (image captioning, BrowseWeb). */
export const CLAUDE_HAIKU = anthropicModel("claude-haiku-4-5-20251001", {
	inputCostPerMillion: 0.8,
	outputCostPerMillion: 4,
	maxTokens: 8_096,
});

/** DeepSeek V3.2 via OpenRouter — text-only, strong reasoning, cheap ($0.25/$0.38 per MTok). */
export const DEEPSEEK_V3_2 = withOpenRouterAffinity(
	getBuiltinModel("openrouter", "deepseek/deepseek-v3.2"),
);

/** Mistral Ministral 14B 2512 via OpenRouter — text + image, cheap vision model ($0.20/$0.20 per MTok). */
export const MINISTRAL_14B = withOpenRouterAffinity(
	getBuiltinModel("openrouter", "mistralai/ministral-14b-2512"),
);

/**
 * Resolve a well-known model ID to its pre-configured Model constant with accurate
 * cost data. Falls through to parseModel for any ID not explicitly listed.
 * Use this instead of a cascade of if/else in callers.
 */
export function resolveModel(id: string): Model<string> {
	for (const m of [CLAUDE_SONNET, CLAUDE_OPUS, CLAUDE_HAIKU]) {
		if (id === m.id) return m;
	}
	return parseModel(id);
}

// Vendor/family patterns known to support image input, for OpenRouter model IDs
// not yet in the generated registry (very recent releases). The registry
// (providers/data/openrouter.json, refreshed via pi-ai) is the real source of
// truth for any model already listed — this table only covers the miss path.
// Maintain as new vision-capable families ship. A false negative here silently
// disables image auto-description (issue #40); a false positive sends an image
// to a model that rejects it — err toward well-established families only.
const VISION_CAPABLE_ID_PATTERNS: RegExp[] = [
	/^anthropic\//,
	/^google\/gemini-/,
	/^openai\/gpt-4o/,
	/^openai\/gpt-4-turbo/,
	/^openai\/o1/,
	/^meta-llama\/llama-3\.2-(11b|90b)-vision/,
	/^mistralai\/pixtral/,
	/^qwen\/qwen2(\.5)?-vl/,
	/^x-ai\/grok-4/,
	/^amazon\/nova/,
];

function supportsVisionFallback(id: string): boolean {
	return VISION_CAPABLE_ID_PATTERNS.some((pattern) => pattern.test(id));
}

/**
 * Resolve a model ID string to a Model object.
 * IDs containing "/" are treated as OpenRouter models (e.g. "deepseek/deepseek-v3.2",
 * "anthropic/claude-sonnet-4-6"). IDs without "/" are Anthropic Claude models.
 *
 * For OpenRouter IDs in the pi-ai generated registry, the pre-computed cost and
 * capability data is used. For IDs not in the registry (newly released models or any
 * valid OpenRouter model slug), a descriptor is constructed with default costs
 * ($3/$15 per MTok, 128k context) and image support inferred from
 * VISION_CAPABLE_ID_PATTERNS above. Add an explicit constant above to override.
 */
/** The pre-generated OpenRouter registry entry for an id, if pi-ai ships one. */
function registeredOpenRouterModel(id: string) {
	// biome-ignore lint/suspicious/noExplicitAny: getBuiltinModel expects a literal from models.generated; arbitrary IDs require the cast
	return getBuiltinModel("openrouter", id as any) ?? undefined;
}

export function parseModel(id: string): Model<string> {
	if (id.includes("/")) {
		const registered = registeredOpenRouterModel(id);
		if (registered) return withOpenRouterAffinity(registered);
		// Not in the pre-generated registry — construct a descriptor directly.
		return withOpenRouterAffinity({
			id,
			name: id,
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: supportsVisionFallback(id) ? ["text", "image"] : ["text"],
			cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_096,
		});
	}
	return anthropicModel(id);
}

/** First-party Anthropic ids the platform prices and offers; anything else without a "/" is unknown. */
export const KNOWN_ANTHROPIC_MODEL_IDS: readonly string[] = [
	CLAUDE_OPUS.id,
	CLAUDE_SONNET.id,
	CLAUDE_HAIKU.id,
];

/**
 * True when the id is priced from a real table: a known Anthropic id or an
 * OpenRouter id present in pi-ai's generated registry. `parseModel` accepts
 * anything and prices the unknown at Sonnet rates — fine for a developer's
 * experiment, not for a tenant's config (audit MD1).
 */
export function isKnownModelId(id: string): boolean {
	if (id.includes("/")) return registeredOpenRouterModel(id) !== undefined;
	return KNOWN_ANTHROPIC_MODEL_IDS.includes(id);
}

type ModelFields = { model?: string; visionModel?: string };
const MODEL_FIELDS = ["model", "visionModel"] as const;

/**
 * The model fields a config sets to an unknown id — empty when acceptable.
 * With `previous` (an edit of a stored config), a field whose value is
 * unchanged is not re-checked: an id that was accepted when the mission was
 * created, or before this check existed, must not block unrelated edits
 * (issue #86). Only an id the edit introduces is refused.
 */
export function unknownModelFields(
	mission: ModelFields,
	previous?: ModelFields,
): { field: (typeof MODEL_FIELDS)[number]; id: string }[] {
	return MODEL_FIELDS.flatMap((field) => {
		const id = mission[field];
		if (typeof id !== "string" || isKnownModelId(id)) return [];
		if (previous && previous[field] === id) return [];
		return [{ field, id }];
	});
}

/** The unknown model ids a config names (see unknownModelFields). */
export function unknownModelIds(
	mission: ModelFields,
	previous?: ModelFields,
): string[] {
	return unknownModelFields(mission, previous).map((u) => u.id);
}

/**
 * Throws in parseTeamConfig's own message style when a config names a model
 * the platform cannot price (MD1). Pass the stored mission as `previous` when
 * validating an edit, so only newly introduced ids are refused.
 */
export function assertKnownModels(
	mission: ModelFields,
	previous?: ModelFields,
): void {
	const unknown = unknownModelFields(mission, previous);
	if (unknown.length === 0) return;
	throw new Error(
		`Team config validation failed:\n${unknown.map((u) => `  mission.${u.field}: unknown model id "${u.id}"`).join("\n")} — use a model from the catalog (GET /api/models)`,
	);
}
