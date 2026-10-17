/**
 * Named phases of one agent turn, called in order by `runAgent`
 * (agent-runner.ts). Each one reads only what it is passed; the turn's
 * mutable state (mental map, turn number, call sequence) stays in runAgent.
 */

import type { AgentConfig } from "@magi/agent-config";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { type AgentRunContext, resolveLiveLimits } from "./agent-runner.js";
import type { MissionStats } from "./agent-stats.js";
import {
	buildRules,
	evaluateLimits,
	type LimitConfig,
	LimitExceededError,
} from "./limits.js";
import type { MailboxMessage } from "./mailbox.js";
import { upsertManagedRegion } from "./mental-map.js";
import {
	MY_OBJECTIVES_KEY,
	renderMyObjectives,
} from "./objectives/agent-view.js";
import {
	attributeTurnCost,
	STALE_TURNS,
	turnsSinceLastAttribution,
} from "./objectives/attribution.js";

/**
 * The daemon-managed #my-objectives section, re-rendered from the objectives
 * store (ADR-0019) — the agent's owned tasks/KPIs plus the staleness nudge
 * when its cost has gone unattributed for several turns. Returns the updated
 * mental map, or null when there is nothing to change. A store failure never
 * breaks the turn: it is logged and the mental map is left alone.
 */
export async function syncObjectivesSection(
	ctx: Pick<AgentRunContext, "objectivesRepo">,
	missionId: string,
	agentId: string,
	turnNumber: number,
	mentalMapHtml: string,
): Promise<string | null> {
	if (!ctx.objectivesRepo) return null;
	try {
		const tree = await ctx.objectivesRepo.readTree(missionId);
		const costEvents = await ctx.objectivesRepo.readCostEvents(missionId);
		const staleAttributionTurns = turnsSinceLastAttribution(
			costEvents,
			agentId,
			turnNumber,
		);
		const section = renderMyObjectives(tree, agentId, {
			staleAttributionTurns,
			staleThreshold: STALE_TURNS,
		});
		if (section === null) return null;
		return upsertManagedRegion(mentalMapHtml, MY_OBJECTIVES_KEY, section);
	} catch (e) {
		console.error("[agent-runner] objectives sync failed", {
			missionId,
			agentId,
			error: (e as Error).message,
		});
		return null;
	}
}

/** What the model is shown at session start, printed when DEBUG_SESSIONS=1. */
export function printSessionDebug(
	agentId: string,
	turnNumber: number,
	systemPrompt: string,
	dynamicContext: string,
	previousMessages: Message[],
): void {
	const sep = "═".repeat(72);
	console.log(`\n${sep}`);
	console.log(`[DEBUG] Agent: ${agentId}  Turn: ${turnNumber}`);
	console.log(`${sep}`);
	console.log("[DEBUG] SYSTEM PROMPT:\n");
	console.log(systemPrompt);
	console.log(`\n${"─".repeat(72)}`);
	console.log("[DEBUG] DYNAMIC CONTEXT (messages[0], not persisted):\n");
	console.log(dynamicContext);
	if (previousMessages.length > 0) {
		console.log(`\n${"─".repeat(72)}`);
		console.log("[DEBUG] PREVIOUS MESSAGES (passed as prior context):\n");
		for (const m of previousMessages) {
			const preview =
				typeof m.content === "string"
					? m.content.slice(0, 500)
					: JSON.stringify(m.content).slice(0, 500);
			console.log(
				`  [${m.role}] ${preview}${preview.length >= 500 ? "…" : ""}`,
			);
		}
	} else {
		console.log("\n[DEBUG] PREVIOUS MESSAGES: (none — first session)");
	}
	console.log(`${sep}\n`);
}

/**
 * The per-check limit enforcer (live config reads, ADR-0018). Rules are built
 * from the agent's `limits` layered over conservative soft defaults; a no-op
 * without a stats collector (the rules read its turn accumulator and fresh
 * lifetime totals). Soft alerts fire at most once per rule per turn; a hard
 * breach alerts and throws LimitExceededError so the inner loop stops before
 * the next LLM call or tool round. `getTurnNumber` is read live so the
 * conversation-recovery retry reports the right turn.
 */
export function createLimitEnforcer(
	ctx: Pick<
		AgentRunContext,
		"statsCollector" | "missionConfig" | "onLimitAlert"
	>,
	agent: AgentConfig,
	missionId: string,
	getTurnNumber: () => number,
): (() => Promise<void>) | undefined {
	if (!ctx.statsCollector) return undefined;
	const stats = ctx.statsCollector;
	const agentId = agent.id;
	const firedSoftLimits = new Set<string>();
	return async () => {
		const turn = stats.getTurn(agentId);
		if (!turn) return;
		// Read the agent's current `limits` fresh — a cockpit edit takes effect
		// on the very next check. A transient read failure falls back to the
		// boot-time snapshot rather than skipping enforcement: a last-known-good
		// config is available for free.
		let liveLimits: LimitConfig = agent.limits ?? {};
		try {
			const live = (await ctx.missionConfig?.readTeamConfig(missionId)) ?? null;
			liveLimits = resolveLiveLimits(live, agentId, agent.limits ?? {});
		} catch (e) {
			console.error(
				`[agent-runner] readTeamConfig failed during limit check, falling back to boot-time snapshot { missionId: ${missionId}, agentId: ${agentId} }: ${(e as Error).message}`,
			);
		}
		const limitRules = buildRules(liveLimits);
		if (limitRules.length === 0) return;
		// Always read fresh from missionStats — never trust a cache for a value
		// a hard limit is checked against (agent-stats.ts header). A transient
		// failure treats lifetime as unknown for this one check; it is re-read
		// on every subsequent call or tool result.
		let lifetime: MissionStats | undefined;
		try {
			lifetime = (await stats.readLifetime(missionId, agentId)) ?? undefined;
		} catch (e) {
			console.error(
				`[agent-runner] readLifetime failed during limit check { missionId: ${missionId}, agentId: ${agentId} }: ${(e as Error).message}`,
			);
		}
		const breaches = evaluateLimits(turn, lifetime, limitRules);
		for (const b of breaches) {
			if (b.rule.severity === "soft" && !firedSoftLimits.has(b.rule.id)) {
				firedSoftLimits.add(b.rule.id);
				ctx.onLimitAlert?.({ agentId, turnNumber: getTurnNumber(), breach: b });
			}
		}
		const hard = breaches.find((b) => b.rule.severity === "hard");
		if (hard) {
			ctx.onLimitAlert?.({
				agentId,
				turnNumber: getTurnNumber(),
				breach: hard,
			});
			throw new LimitExceededError(hard);
		}
	};
}

/**
 * Safety net for a supervisor-triggered run that never posted back: send a
 * brief status so the operator always sees an acknowledgment — the last text
 * reply, or the loop's error, rather than a misleading "Task completed."
 */
export async function postSupervisorFallback(
	ctx: Pick<AgentRunContext, "mailboxRepo" | "onUserMessage">,
	p: {
		missionId: string;
		agentId: string;
		supervisorId: string;
		incoming: MailboxMessage[];
		lastAssistantText: string;
		loopMessages: Message[];
	},
): Promise<void> {
	const loopError = p.loopMessages
		.filter((m): m is AssistantMessage => m.role === "assistant")
		.map((m) => m.errorMessage)
		.find((e) => !!e);
	const body =
		p.lastAssistantText ||
		(loopError
			? `I encountered an error and could not complete the task.\n\nError: ${loopError}`
			: "Task completed.");
	const incomingSubject = p.incoming[0]?.subject ?? "";
	console.warn(
		`[runAgent] ${p.agentId}: no PostMessage to supervisor "${p.supervisorId}" — sending auto-reply`,
	);
	const autoReply = await ctx.mailboxRepo.post({
		missionId: p.missionId,
		from: p.agentId,
		to: [p.supervisorId],
		subject: incomingSubject ? `Re: ${incomingSubject}` : "Re: (no subject)",
		body,
	});
	// SSE frontends (copilot chat) only see the reply through this callback.
	if (p.supervisorId === "user") ctx.onUserMessage?.(autoReply);
}

/**
 * Close the turn, whatever its outcome: checkpoint the shared workspace
 * (git-commit-on-sleep, so an aborted turn's partial work is kept), finalize
 * the turn statistics (an aborted run still cost money), then attribute the
 * turn's cost to the tasks the agent updated (ADR-0019) from a fresh
 * lifetime read. Attribution failures never break the turn.
 */
export async function finalizeTurn(
	ctx: Pick<
		AgentRunContext,
		"commitWorkspace" | "statsCollector" | "objectivesRepo"
	>,
	p: {
		missionId: string;
		agentId: string;
		turnNumber: number;
		aborted: boolean;
	},
): Promise<void> {
	const git =
		(await ctx.commitWorkspace?.(`turn: ${p.agentId}/${p.turnNumber}`)) ??
		undefined;
	// Captured before endTurn() drops the accumulator.
	const turnSnapshot = ctx.statsCollector?.getTurn(p.agentId);
	await ctx.statsCollector?.endTurn(
		p.agentId,
		p.aborted ? "aborted" : "complete",
		git ?? undefined,
	);
	if (!ctx.objectivesRepo || !ctx.statsCollector || !turnSnapshot) return;
	try {
		const freshLifetime = await ctx.statsCollector.readLifetime(
			p.missionId,
			p.agentId,
		);
		await attributeTurnCost(ctx.objectivesRepo, p.missionId, {
			agentId: p.agentId,
			turnNumber: turnSnapshot.turnNumber,
			windowStart: turnSnapshot.startedAt,
			windowEnd: new Date(),
			lifetimeCostUsd: freshLifetime?.lifetimeCostUsd ?? turnSnapshot.costUsd,
		});
	} catch (e) {
		console.error("[agent-runner] cost attribution failed", {
			missionId: p.missionId,
			agentId: p.agentId,
			error: (e as Error).message,
		});
	}
}
