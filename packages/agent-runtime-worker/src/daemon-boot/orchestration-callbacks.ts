import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
	Usage,
} from "@mariozechner/pi-ai";
import type { LimitAlert } from "../limits.js";
import { missionLifetimeCostUsd } from "../limits.js";
import {
	MISSION_COPILOT_AGENT_ID,
	seedMissionCopilotObjectives,
} from "../mission-copilot.js";
import { migrateLegacyObjectivesStore } from "../objectives/migrate-legacy-store.js";
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

export interface RemainingOrchestrationCallbacks {
	onLimitAlert: (alert: LimitAlert) => void;
	onAgentError: (agentId: string, errorMessage: string) => void;
	onAgentStart: (agentId: string) => void;
	onWorkspaceReady: (workdirs: Map<string, string>) => void;
	onAgentDone: (agentId: string) => void;
	onIdle: () => void;
	onMentalMapUpdate: (agentId: string, html: string) => void;
}

/**
 * The rest of runOrchestrationLoop's callbacks, bundled into one extraction
 * since each is small on its own — onLimitAlert and onWorkspaceReady are the
 * only two with any real logic; the other four are one-line delegations to
 * the monitor.
 */
export function createRemainingOrchestrationCallbacks(
	ctx: Pick<
		BootContext,
		| "monitor"
		| "anomalyRecorder"
		| "missionId"
		| "mailboxRepo"
		| "sharedDir"
		| "objectivesRepo"
	>,
	missionCopilotEnabled: boolean,
): RemainingOrchestrationCallbacks {
	return {
		onLimitAlert: (alert) => {
			const { agentId, turnNumber, breach } = alert;
			const { rule, value } = breach;
			// Surface on the dashboard immediately.
			ctx.monitor.push("limit-alert", {
				agentId,
				turnNumber,
				severity: rule.severity,
				ruleId: rule.id,
				metric: rule.metric,
				value,
				threshold: rule.threshold,
				label: rule.label,
			});
			console.warn(
				`[daemon] limit ${rule.severity} ${rule.id}: ${agentId} turn ${turnNumber} — ${rule.metric}=${value} > ${rule.threshold} (${rule.label})`,
			);
			const body =
				`Agent "${agentId}" breached a ${rule.severity} limit on turn ${turnNumber}: ` +
				`${rule.metric}=${value} exceeded threshold ${rule.threshold} (${rule.label}).` +
				(rule.severity === "hard"
					? " The turn was aborted."
					: " The turn continued; assess whether intervention is warranted.");
			// Persist + wake this mission's own copilot (and, for hard
			// breaches, relay to the control-plane copilot) — both handled
			// internally by anomalyRecorder (ADR-0020).
			ctx.anomalyRecorder
				.record({
					missionId: ctx.missionId,
					category: "limit-breach",
					severity: rule.severity,
					agentId,
					turnNumber,
					message: body,
				})
				.catch((e: Error) =>
					console.error(
						`[daemon] failed to record limit-breach anomaly: ${e.message}`,
					),
				);
			// Also notify the operator directly (issue #41) — the copilot
			// relay above is not a substitute: a hard breach on every agent,
			// including the mission copilot itself, previously left no one
			// able to surface it, and the operator only found out days later.
			if (rule.severity === "hard") {
				ctx.mailboxRepo
					.post({
						missionId: ctx.missionId,
						from: "system",
						to: ["user"],
						subject: `Spend limit hit — "${agentId}"`,
						body,
					})
					.catch((e: Error) =>
						console.error(
							`[daemon] failed to notify operator of limit breach { missionId: "${ctx.missionId}", agentId: "${agentId}" }: ${e.message}`,
						),
					);
			}
		},
		// Whole-turn crash (runAgent rejected). This is purely the SSE
		// dashboard signal — orchestrator.ts's own dispatch-error handler
		// (which has the errMsg first-hand) records the anomaly and relays
		// it; recording it again here from the same event would double it.
		onAgentError: (agentId, errorMessage) =>
			ctx.monitor.push("agent-error", {
				agentId,
				errorMessage,
				transient: false,
			}),
		onAgentStart: (agentId) => ctx.monitor.notifyAgentStart(agentId),
		onWorkspaceReady: (workdirs) => {
			ctx.monitor.setAgentWorkdirs(workdirs);
			// Migrate any legacy file-based objectives (ADR-0019) after
			// provisioning, not at injection time — provision() is what
			// creates sharedDir/objectives/ on disk for a fresh-from-template
			// mission. Idempotent (no-ops once a mission has an
			// objectivesGoals doc), so a resume_mission reprovision (which
			// re-runs this whole path) never re-imports. Chained (not fired
			// in parallel) before the copilot seed so a legacy
			// OBJ-MISSION-FIT is picked up first and the seed correctly
			// no-ops on it.
			migrateLegacyObjectivesStore(
				ctx.sharedDir,
				ctx.missionId,
				ctx.objectivesRepo,
			)
				.catch((e: Error) =>
					console.error(
						`[daemon] failed to migrate legacy objectives store: ${e.message}`,
					),
				)
				.then(() => {
					if (missionCopilotEnabled && workdirs.has(MISSION_COPILOT_AGENT_ID)) {
						return seedMissionCopilotObjectives(
							ctx.objectivesRepo,
							ctx.missionId,
						).catch((e: Error) =>
							console.error(
								`[daemon] failed to seed mission copilot objectives: ${e.message}`,
							),
						);
					}
				});
		},
		onAgentDone: (agentId) => ctx.monitor.notifyAgentDone(agentId),
		onIdle: () => ctx.monitor.notifyIdle(),
		onMentalMapUpdate: (agentId, html) =>
			ctx.monitor.notifyMentalMapUpdate(agentId, html),
	};
}
