import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
	Usage,
} from "@mariozechner/pi-ai";
import { missionLifetimeCostUsd } from "../limits.js";
import type { BootContext } from "./context.js";

function logMessage(msg: Message, agentId?: string): void {
	if (msg.role === "user") return;
	const speaker = agentId ?? "assistant";
	if (msg.role === "assistant") {
		const am = msg as AssistantMessage;
		if (am.stopReason === "error" || am.stopReason === "aborted") {
			console.error(
				`  [${speaker}] ✗ LLM error (${am.stopReason}): ${am.errorMessage ?? "(no message)"}`,
			);
		}
		for (const block of am.content) {
			if (block.type === "text" && block.text.trim()) {
				const t = block.text.trim().replace(/\n+/g, " ");
				console.log(
					`  [${speaker}] ${t.length > 120 ? `${t.slice(0, 120)}…` : t}`,
				);
			} else if (block.type === "toolCall") {
				// Full detail for PostMessage (key inter-agent event); compact one-liner for the rest.
				if (block.name === "PostMessage") {
					const args = block.arguments as { to?: unknown; subject?: unknown };
					const to = Array.isArray(args.to)
						? (args.to as string[]).join(", ")
						: String(args.to ?? "?");
					const subject = String(args.subject ?? "(no subject)");
					console.log(`  [${speaker}] → PostMessage to:${to} "${subject}"`);
				} else {
					// First key=value pair as a terse hint.
					const entries = Object.entries(
						block.arguments as Record<string, unknown>,
					);
					const hint =
						entries.length > 0
							? ` ${String(entries[0][1] ?? "")
									.replace(/\n+/g, " ")
									.slice(0, 60)}`
							: "";
					console.log(`  [${speaker}] → ${block.name}${hint}`);
				}
			}
		}
	} else {
		const tr = msg as ToolResultMessage;
		if (tr.isError) {
			const text = tr.content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("")
				.trim()
				.replace(/\n+/g, " ");
			const preview = text.length > 100 ? `${text.slice(0, 100)}…` : text;
			console.error(`  [${speaker}] ✗ ${tr.toolName}: ${preview}`);
		} else {
			console.log(`  [${speaker}] ← ${tr.toolName} ok`);
		}
	}
}

/**
 * Per-LLM-call telemetry, mission-wide spend-cap enforcement, and LLM-error
 * classification/anomaly recording — the busiest of runOrchestrationLoop's
 * callbacks, extracted on its own given its size and the safety-critical
 * spend-cap logic it contains.
 */
export function createOnAgentMessage(
	ctx: Pick<
		BootContext,
		| "usageAccumulator"
		| "monitor"
		| "statsCollector"
		| "missionId"
		| "missionConfigRepo"
		| "maxCostUsd"
		| "anomalyRecorder"
		| "mailboxRepo"
	>,
): (agentId: string, msg: Message) => Promise<void> {
	return async (agentId, msg) => {
		logMessage(msg, agentId);
		if (msg.role !== "assistant") return;

		const usage = (msg as AssistantMessage).usage as Usage;
		// Session-only telemetry for the console log line and the SSE
		// live ticker — cosmetic, never checked against a limit (see
		// usage.ts header). The mission-wide cap below reads fresh from
		// missionStats instead.
		ctx.usageAccumulator.add(agentId, usage);
		console.log(ctx.usageAccumulator.callLine(agentId, usage));
		ctx.monitor.push("llm-call", {
			agentId,
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			callCostUsd: usage.cost.total,
			agentTotalUsd:
				ctx.usageAccumulator.agents().find((a) => a.agentId === agentId)
					?.costUsd ?? 0,
			missionTotalUsd: ctx.usageAccumulator.totalCostUsd(),
		});
		// Mission-wide spend cap (ADR-0018): read the cap fresh from the
		// mission's persisted config on every call — never the boot-time
		// teamConfig snapshot — so a cap added, changed, or cleared live
		// (cockpit or mission copilot) is enforced without a restart.
		// Falls back to the boot-time value (mission config or
		// MAX_COST_USD env var, resolved once above) when a live read
		// fails or the live doc genuinely has no cap configured. A
		// transient Mongo read failure must not crash the agent's turn —
		// fail open (skip this one check) and log; both reads are
		// re-attempted on every subsequent LLM call, so a one-off hiccup
		// self-heals rather than blocking the mission.
		try {
			const [snapshot, liveConfig] = await Promise.all([
				ctx.statsCollector.readMissionSnapshot(ctx.missionId),
				ctx.missionConfigRepo.readTeamConfig(ctx.missionId),
			]);
			const effectiveCap = liveConfig?.mission.maxCostUsd ?? ctx.maxCostUsd;
			if (effectiveCap !== null) {
				const missionTotal = missionLifetimeCostUsd(snapshot);
				if (missionTotal >= effectiveCap) {
					await ctx.monitor.notifyCostPause(missionTotal, effectiveCap);
					// This path previously never woke the copilot or the
					// operator (issue #41) — only a dashboard-only SSE event,
					// unlike the per-agent path above. A silent mission-wide
					// pause cost 5 days of unattended operation in production.
					const pauseBody = `Mission-wide spend cap reached: $${missionTotal.toFixed(2)} of $${effectiveCap.toFixed(2)}. All agents are paused until the cap is raised or cleared.`;
					ctx.anomalyRecorder
						.record({
							missionId: ctx.missionId,
							category: "limit-breach",
							severity: "hard",
							message: pauseBody,
						})
						.catch((e: Error) =>
							console.error(
								`[daemon] failed to record mission-cap anomaly { missionId: "${ctx.missionId}" }: ${e.message}`,
							),
						);
					ctx.mailboxRepo
						.post({
							missionId: ctx.missionId,
							from: "system",
							to: ["user"],
							subject: "Mission spend cap reached",
							body: pauseBody,
						})
						.catch((e: Error) =>
							console.error(
								`[daemon] failed to notify operator of mission-cap pause { missionId: "${ctx.missionId}" }: ${e.message}`,
							),
						);
				}
			}
		} catch (e) {
			console.error(
				`[daemon] mission cap check failed { missionId: ${ctx.missionId} }: ${(e as Error).message}`,
			);
		}
		const am = msg as AssistantMessage;
		if (am.stopReason === "error") {
			const errMsg = am.errorMessage ?? "";
			// Classify: credit/auth errors require operator action;
			// overload/rate-limit errors are transient and auto-resolve.
			const transient =
				errMsg.includes("overloaded") ||
				errMsg.includes("rate limit") ||
				errMsg.includes("529");
			ctx.monitor.push("agent-error", {
				agentId,
				errorMessage: errMsg,
				transient,
			});
			ctx.anomalyRecorder
				.record({
					missionId: ctx.missionId,
					category: "llm-error",
					severity: transient ? "soft" : "hard",
					agentId,
					message: `Agent "${agentId}" had an LLM call fail: ${errMsg}`,
				})
				.catch((e: Error) =>
					console.error(
						`[daemon] failed to record llm-error anomaly: ${e.message}`,
					),
				);
		}
	};
}
