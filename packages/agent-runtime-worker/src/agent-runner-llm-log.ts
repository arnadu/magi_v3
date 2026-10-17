/**
 * The per-turn `onLlmCall` hook: writes the `llmCallLog` audit entry and
 * feeds the stats collector. Split from `runAgent` (agent-runner.ts) so the
 * cost/attribution rules are readable in one place: the answering model's
 * price table is used (a vision call names its own model, COST-1), the loop's
 * `callId` is kept so the entry can be joined to its transcript message, and
 * a reflection call's cost goes to lifetime totals because it has no turn.
 */

import type { AgentRunContext } from "./agent-runner.js";
import {
	computeCost,
	resolveCallCost,
	truncateOldMessages,
	truncateToolBodies,
} from "./llm-call-log.js";
import { type LlmCallEvent, stripImageData } from "./llm-meter.js";

export function createLlmCallHook(
	ctx: Pick<AgentRunContext, "llmCallLog" | "statsCollector" | "model">,
	missionId: string,
	agentId: string,
): (
	turnNumber: number,
	isReflection: boolean,
) => ((event: LlmCallEvent) => Promise<void>) | undefined {
	return (turnNumber: number, isReflection: boolean) => {
		if (!ctx.llmCallLog && !ctx.statsCollector) return undefined;
		return async (event: LlmCallEvent) => {
			// A vision call (InspectImage, captioning, OCR) names its own model;
			// pricing it with the loop model's table misstated its cost (COST-1).
			const model = event.model ?? ctx.model;
			const usage = event.response.usage as {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				providerCost?: number;
			};
			const modelCost = model.cost as {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			const estimatedCost = computeCost(usage, modelCost);
			const { cost, costEstimated } = resolveCallCost(
				estimatedCost,
				model.provider,
				usage.providerCost,
			);
			if (ctx.llmCallLog) {
				await ctx.llmCallLog.append({
					missionId,
					agentId,
					turnNumber,
					isReflection,
					savedAt: new Date(),
					model: model.id,
					...(event.callId ? { callId: event.callId } : {}),
					costEstimated,
					input: {
						systemPrompt: event.systemPrompt,
						messages: truncateOldMessages(
							truncateToolBodies(stripImageData(event.messages)),
						),
						toolNames: event.toolNames,
					},
					output: {
						message: event.response,
						stopReason: event.response.stopReason,
					},
					usage: {
						inputTokens: usage.input,
						outputTokens: usage.output,
						cacheReadTokens: usage.cacheRead,
						cacheWriteTokens: usage.cacheWrite,
						cost,
					},
				});
			}
			if (ctx.statsCollector) {
				if (isReflection) {
					// Reflection has no active turn to attribute to (it runs before
					// startTurn) — record its cost against lifetime totals directly so
					// missionStats/the mission-wide cap don't under-count real spend.
					await ctx.statsCollector.recordReflectionCost(
						missionId,
						agentId,
						cost.totalCostUsd,
					);
				} else {
					await ctx.statsCollector.recordLlmCall(agentId, {
						inputTokens: usage.input,
						outputTokens: usage.output,
						cacheReadTokens: usage.cacheRead,
						cacheWriteTokens: usage.cacheWrite,
						costUsd: cost.totalCostUsd,
					});
				}
			}
		};
	};
}
