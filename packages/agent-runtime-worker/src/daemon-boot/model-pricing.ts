import { resolveModel } from "../models.js";
import { enrichModelPricing } from "../openrouter-pricing.js";
import type { BootContext } from "./context.js";

/**
 * Resolve the mission's LLM + vision models and overwrite OpenRouter models'
 * static cost with live list pricing (no-op for first-party Anthropic
 * models, whose cost is already exact — see issue #10).
 */
export async function resolveModelsAndPricing(
	ctx: Pick<BootContext, "teamConfig">,
): Promise<Pick<BootContext, "modelId" | "model" | "visionModel">> {
	const modelId =
		ctx.teamConfig.mission.model ?? process.env.MODEL ?? "claude-sonnet-4-6";
	const model = resolveModel(modelId);

	const visionModelId =
		ctx.teamConfig.mission.visionModel ??
		process.env.VISION_MODEL ??
		"claude-haiku-4-5-20251001";
	const visionModel = resolveModel(visionModelId);

	await Promise.all([
		enrichModelPricing(model),
		enrichModelPricing(visionModel),
	]);

	return { modelId, model, visionModel };
}
