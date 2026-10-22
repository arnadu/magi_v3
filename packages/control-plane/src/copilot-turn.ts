/**
 * One control-plane copilot turn under its spend guard (CST-3). Split from
 * copilot-daemon.ts, whose watch loop decides when a turn runs; this decides
 * how it runs and when it is stopped.
 */

import {
	type AgentRunContext,
	type AssistantMessage,
	type MailboxMessage,
	type Message,
	runAgent,
} from "@magi/agent-runtime-worker";
import type { Db } from "mongodb";
import { createCopilotTurnGuard } from "./copilot-spend.js";

export interface CopilotTurnDeps {
	db: Db;
	missionId: string;
	userId: string;
	agentId: string;
	ctx: Omit<AgentRunContext, "onMessage">;
	pushEvent: (type: string, data: unknown) => void;
}

/** runAgent, where an error caused by the guard's own stop is a stop, not a failed turn to retry. */
async function runAgentUnlessStopped(
	agentId: string,
	messages: MailboxMessage[],
	ctx: AgentRunContext,
	guard: { signal: AbortSignal; stopReason: () => string | null },
): Promise<void> {
	try {
		await runAgent(agentId, messages, ctx, guard.signal);
	} catch (e) {
		if (guard.stopReason() === null) throw e;
	}
}

/**
 * One copilot turn under its guard (CST-3): the spend cap is re-checked after
 * every LLM call, and the turn is stopped at the cap or at its wall-clock
 * bound. A stopped turn is reported to the cockpit and ends normally — its
 * messages count as handled.
 */
export async function runCopilotTurn(
	deps: CopilotTurnDeps,
	messages: MailboxMessage[],
	lifetime: AbortSignal,
): Promise<void> {
	const { pushEvent } = deps;
	const guard = createCopilotTurnGuard({
		db: deps.db,
		userId: deps.userId,
		parent: lifetime,
	});
	console.log(`[copilot-daemon] Starting turn (${messages.length} message(s))`);
	try {
		await runAgentUnlessStopped(
			deps.agentId,
			messages,
			{
				...deps.ctx,
				onMessage: async (msg: Message) => {
					pushEvent("copilot-loop-msg", msg);
					if (msg.role !== "assistant") return;
					// Surface LLM errors (budget exhausted, overloaded, etc.) to the
					// Fly log and the copilot chat UI — these would otherwise be silent.
					const am = msg as AssistantMessage;
					if (am.stopReason === "error") {
						const errorMessage = am.errorMessage ?? "LLM error (no details)";
						console.error(`[copilot-daemon] LLM error: ${errorMessage}`);
						pushEvent("copilot-error", { errorMessage });
					}
					await guard.checkAfterCall();
				},
			},
			guard,
		);
		const stopped = lifetime.aborted ? null : guard.stopReason();
		if (stopped) {
			console.warn(
				`[copilot-daemon] Turn stopped { missionId: "${deps.missionId}", reason: "${stopped}" }`,
			);
			pushEvent("copilot-error", {
				errorMessage: `The copilot stopped mid-turn: ${stopped}.`,
			});
		} else {
			console.log("[copilot-daemon] Turn complete");
		}
	} finally {
		guard.dispose();
	}
}
