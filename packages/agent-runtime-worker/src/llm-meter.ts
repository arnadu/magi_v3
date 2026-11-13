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

import type { LlmCallCost } from "@magi/agent-config";
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
	/** Set by runInnerLoop; absent for tool-side calls, which produce no transcript message. */
	callId?: string;
	/**
	 * The call's cost when it is not priced per token (image generation): the
	 * provider's reported charge (`estimated: false`), or a ceiling price
	 * (`estimated: true`) when no charge was reported. Overrides the token
	 * computation, whose registry prices are $0 for most per-image models.
	 */
	fixedCost?: { totalUsd: number; estimated: boolean };
}

/** The cost both meters record for an event: its fixed cost if any, else tokens × prices, with the provider's charge preferred. */
export function resolveEventCost(
	event: LlmCallEvent,
	model: Model<string>,
): { cost: LlmCallCost; costEstimated: boolean } {
	const usage = event.response.usage as {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		providerCost?: number;
	};
	const estimated = computeCost(usage, model.cost);
	if (event.fixedCost) {
		return {
			cost: { ...estimated, totalCostUsd: event.fixedCost.totalUsd },
			costEstimated: event.fixedCost.estimated,
		};
	}
	return resolveCallCost(estimated, model.provider, usage.providerCost);
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
 * A meter for calls made outside any agent turn: the monitor's upload
 * pipeline (under a synthetic agent id) and background jobs' calls through
 * the Tool API (under the job's agent). There is no turn to attribute them
 * to, so they never reach the per-turn statistics; the audit log always sees
 * them, and `onCost` lets a caller charge them elsewhere (the Tool API charges
 * the agent's lifetime cost, which the mission cap reads).
 */
export function createLogOnlyMeter(
	llmCallLog: Pick<LlmCallLogRepository, "append">,
	missionId: string,
	agentId: string,
	/** Runs after the log entry with the call's cost — e.g. to charge it to the agent and check the cap. */
	onCost?: (costUsd: number) => Promise<void>,
): LlmCallMeter {
	return async (event) => {
		const model = event.model;
		if (!model) return;
		const usage = event.response.usage;
		const { cost, costEstimated } = resolveEventCost(event, model);
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
		await onCost?.(cost.totalCostUsd);
	};
}
