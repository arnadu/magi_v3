import { DEFAULT_MODEL_ID, DEFAULT_VISION_MODEL_ID } from "@magi/agent-config";
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
		ctx.teamConfig.mission.model ?? process.env.MODEL ?? DEFAULT_MODEL_ID;
	const model = resolveModel(modelId);

	const visionModelId =
		ctx.teamConfig.mission.visionModel ??
		process.env.VISION_MODEL ??
		DEFAULT_VISION_MODEL_ID;
	const visionModel = resolveModel(visionModelId);

	await Promise.all([
		enrichModelPricing(model),
		enrichModelPricing(visionModel),
	]);

	return { modelId, model, visionModel };
}
