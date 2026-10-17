/**
 * One metering path for every LLM call made outside `runInnerLoop` (COST-1):
 * InspectImage, the document processor's captioning and OCR, FetchUrl's
 * image descriptions. These used to call `piModels.completeSimple` directly,
 * so their cost reached neither `llmCallLog` nor the turn statistics the
 * spend cap reads — a mission could spend on vision calls indefinitely under
 * a cap that never moved.
 *
 * The meter is the same hook `runInnerLoop` fires (`onLlmCall`), with the
 * model added so a vision model's price table is used for a vision call.
 */

import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import {
	computeCost,
	type LlmCallLogRepository,
	resolveCallCost,
	truncateOldMessages,
	truncateToolBodies,
} from "./llm-call-log.js";
import { piModels } from "./models.js";

export interface LlmCallEvent {
	systemPrompt: string;
	messages: Message[];
	toolNames: string[];
	response: AssistantMessage;
	/** The model that answered; absent means the caller's own loop model. */
	model?: Model<string>;
}

export type LlmCallMeter = (event: LlmCallEvent) => Promise<void>;

export type CompleteFn = (
	model: Model<string>,
	context: Context,
	options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

/**
 * `completeSimple` plus the meter. The meter runs for every outcome the
 * provider returned (errors carry usage too); a thrown transport error has
 * no response and is not metered.
 */
export async function meteredCompleteSimple(
	model: Model<string>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	meter: LlmCallMeter | undefined,
	complete: CompleteFn = (m, c, o) => piModels.completeSimple(m, c, o),
): Promise<AssistantMessage> {
	const response = await complete(model, context, options);
	if (meter) {
		try {
			await meter({
				systemPrompt: context.systemPrompt ?? "",
				messages: context.messages,
				toolNames: (context.tools ?? []).map((t) => t.name),
				response,
				model,
			});
		} catch (e) {
			console.error(
				`[llm-meter] metering failed for ${model.id}: ${(e as Error).message} — the call's cost is missing from the log and the turn stats`,
			);
		}
	}
	return response;
}

/**
 * Image blocks replaced by a marker for logging: a base64 image is hundreds
 * of kilobytes per call, and `llmCallLog` already truncates tool bodies for
 * the same reason.
 */
export function stripImageData<T extends Message>(messages: T[]): T[] {
	return messages.map((m) => {
		if (m.role !== "user" || typeof m.content === "string") return m;
		const content = (m.content as Array<{ type: string }>).map((block) =>
			block.type === "image"
				? ({ type: "text", text: "[image omitted from log]" } as const)
				: block,
		);
		return { ...m, content } as T;
	});
}

/**
 * A meter for calls made outside any agent turn (the monitor's upload
 * pipeline): the call is logged with its cost, under a synthetic agent id,
 * but there is no turn to attribute it to, so it does not count toward the
 * mission's per-turn statistics — only the audit log sees it.
 */
export function createLogOnlyMeter(
	llmCallLog: Pick<LlmCallLogRepository, "append">,
	missionId: string,
	agentId: string,
): LlmCallMeter {
	return async (event) => {
		const model = event.model;
		if (!model) return;
		const usage = event.response.usage as {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			providerCost?: number;
		};
		const estimated = computeCost(usage, model.cost);
		const { cost, costEstimated } = resolveCallCost(
			estimated,
			model.provider,
			usage.providerCost,
		);
		await llmCallLog.append({
			missionId,
			agentId,
			turnNumber: 0,
			isReflection: false,
			savedAt: new Date(),
			model: model.id,
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
	};
}
