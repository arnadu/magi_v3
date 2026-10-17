/**
 * Copilot daemon — persistent wakeup loop for the copilot agent.
 *
 * Watches the mailbox for messages addressed to the copilot, then delegates
 * each turn to the shared runAgent function — the same path as all
 * execution-plane agents. Category B elevated tools (MongoDB + Fly API access)
 * are injected via AgentRunContext.additionalTools; they run in-process rather
 * than through the sudo subprocess isolation used for Tier A tools.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TeamConfig } from "@magi/agent-config";
import { loadTeamConfig } from "@magi/agent-config";
import {
	type AgentIdentity,
	type AgentRunContext,
	type AssistantMessage,
	createMongoAgentStatsRepository,
	createMongoConversationRepository,
	createMongoLlmCallLogRepository,
	createMongoMailboxRepository,
	type LlmCallLogRepository,
	type Message,
	resolveModel,
	runAgent,
	StatsCollector,
} from "@magi/agent-runtime-worker";
import type { Collection, Db } from "mongodb";
import type { PendingActionsStore } from "./copilot-tools.js";
import { createCopilotTools } from "./copilot-tools.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const COPILOT_MISSION_ID = "copilot";

export const COPILOT_WORKDIR = "/home/magi-copilot/workdir";

/**
 * Upper bound on how long the watch loop waits on a single Change Stream
 * subscription before falling back to re-checking for unread mail directly.
 * A Change Stream can miss the one insert it's meant to catch (e.g. a message
 * posted in the narrow window before the stream is fully open server-side) —
 * without this, a missed event leaves the daemon waiting forever on an event
 * that already happened, i.e. silently unresponsive. See runWatchLoop.
 */
const POLL_FALLBACK_MS = 15_000;

/**
 * X-TENANT3 (2026-10-15 audit): each user's copilot gets its own subdirectory
 * of the volume-mounted workdir instead of all users sharing its root, so the
 * `GET /api/copilot/files` route can serve a caller only their own copilot's
 * files. Still one OS identity (`magi-copilot`) for every user: a copilot's
 * own Bash can read another user's subdirectory. Per-user OS identities are
 * the follow-up (Sprint 29 scope, TB-15).
 */
export function copilotWorkdirFor(missionId: string): string {
	if (!/^copilot-[A-Za-z0-9_-]+$/.test(missionId)) {
		throw new Error(`Not a copilot mission id: "${missionId}"`);
	}
	return join(COPILOT_WORKDIR, "users", missionId);
}

function copilotIdentityFor(missionId: string): AgentIdentity {
	const dir = copilotWorkdirFor(missionId);
	return { workdir: dir, sharedDir: dir, linuxUser: "magi-copilot" };
}

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

export interface CopilotDaemonHandle {
	stop(): void;
	/** Resolves when the watch loop has opened its first Change Stream and is ready to receive messages. */
	ready: Promise<void>;
	/**
	 * True while a turn (runAgent call) is actively in flight. stop() aborts
	 * immediately regardless — this is for callers (the /settings model-switch
	 * route) that want to know whether an abort would cut off in-progress work
	 * before deciding to call stop() at all. See copilot-router.ts's busy guard.
	 */
	isBusy(): boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the copilot wakeup loop. Returns a handle to stop it.
 *
 * @param db         Connected MongoDB database.
 * @param repoRoot   Absolute path to the repo root (for loading copilot.yaml).
 * @param modelId    Anthropic / OpenRouter model ID for the copilot's LLM calls.
 * @param pushEvent  Push an SSE event to all connected copilot chat clients.
 * @param pending    Shared store for proposed-but-unconfirmed actions.
 * @param missionId  Override for the copilot missionId (default: COPILOT_MISSION_ID).
 *                   Used in tests to isolate from concurrent production runs.
 */
export function startCopilotDaemon(
	db: Db,
	repoRoot: string,
	modelId: string,
	pushEvent: (type: string, data: unknown) => void,
	pending: PendingActionsStore,
	missionId?: string,
): CopilotDaemonHandle {
	const ac = new AbortController();
	const { signal } = ac;
	const resolvedMissionId = missionId ?? COPILOT_MISSION_ID;

	let resolveReady!: () => void;
	const ready = new Promise<void>((res) => {
		resolveReady = res;
	});

	const busyRef = { current: false };

	runWatchLoop(
		db,
		repoRoot,
		modelId,
		pushEvent,
		pending,
		signal,
		resolvedMissionId,
		resolveReady,
		busyRef,
	).catch((e) => {
		resolveReady(); // unblock waiters even on crash
		if (!signal.aborted) {
			console.error(
				`[copilot-daemon] watch loop crashed: ${(e as Error).message}`,
			);
		}
	});

	return {
		stop() {
			ac.abort();
		},
		ready,
		isBusy() {
			return busyRef.current;
		},
	};
}

// ---------------------------------------------------------------------------
// Skill provisioning
// ---------------------------------------------------------------------------

function provisionCopilotSkills(repoRoot: string, userDir: string): void {
	// When a Fly persistent volume is mounted, the volume root is owned by the
	// process user (magi-operator, uid 999) with mode 0755 — not magi-copilot.
	// Set an ACL entry so the copilot agent subprocess (sudo -u magi-copilot) can
	// create files inside its own workdir. The ACL is stored on the volume and
	// survives restarts; the call is idempotent.
	try {
		execFileSync("setfacl", ["-m", `u:magi-copilot:rwx`, COPILOT_WORKDIR]);
		execFileSync("setfacl", [
			"-d",
			"-m",
			`u:magi-copilot:rwx`,
			COPILOT_WORKDIR,
		]);
	} catch (e) {
		console.warn(
			`[copilot-daemon] setfacl on workdir: ${(e as Error).message}`,
		);
	}

	const dest = join(userDir, "skills", "_platform");
	try {
		mkdirSync(dest, { recursive: true });

		// Team-specific copilot skills.
		const teamSrc = join(repoRoot, "config", "teams", "copilot", "skills");
		if (existsSync(teamSrc)) {
			cpSync(teamSrc, dest, { recursive: true });
		}

		// Platform skills whose SKILL.md the copilot should see via discoverSkills().
		// The copilot uses the built-in category-B tools for GitHub operations, but
		// provisioning the SKILL.md ensures the description appears in the system prompt.
		// `objectives` lets the copilot read the task/KPI script reference so it can
		// design objectives-driven templates (see magi-template-design).
		// `incident-triage` is shared with the mission copilot — this copilot only
		// receives hard-severity anomalies relayed from missions (ADR-0020), and
		// the skill's own "how an anomaly reaches you" section is written for both
		// audiences.
		const platformSkillsToCopy = [
			"github-issues",
			"objectives",
			"incident-triage",
		];
		for (const skill of platformSkillsToCopy) {
			const skillSrc = join(repoRoot, "packages", "skills", skill);
			if (existsSync(skillSrc)) {
				cpSync(skillSrc, join(dest, skill), { recursive: true });
			}
		}
	} catch (e) {
		console.warn(
			`[copilot-daemon] Failed to provision skills: ${(e as Error).message}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Watch loop
// ---------------------------------------------------------------------------

async function runWatchLoop(
	db: Db,
	repoRoot: string,
	modelId: string,
	pushEvent: (type: string, data: unknown) => void,
	pending: PendingActionsStore,
	signal: AbortSignal,
	missionId: string,
	onReady: () => void,
	busyRef: { current: boolean },
): Promise<void> {
	const mailboxCol = db.collection("mailbox");
	const mailboxRepo = createMongoMailboxRepository(db, missionId);
	const conversationRepo = createMongoConversationRepository(db);
	const llmCallLog: LlmCallLogRepository = createMongoLlmCallLogRepository(db);
	// Gives the copilot the same agentTurnStats/missionStats visibility every
	// mission agent already has (Transcripts turn timeline, spend-cap reads) —
	// StatsCollector needs nothing beyond a Db handle, no `missions` collection
	// document required, so this is a drop-in addition with no special-casing.
	const statsCollector = new StatsCollector(
		createMongoAgentStatsRepository(db),
	);
	const model = resolveModel(modelId);

	let teamConfig: TeamConfig;
	try {
		// This file's own agent is legitimately named "copilot" — its own
		// identity, unrelated to the "mission-copilot" id ADR-0016 reserves for
		// the daemon-injected mission copilot, so no exemption is needed here.
		teamConfig = loadTeamConfig(
			join(repoRoot, "config", "teams", "copilot.yaml"),
		);
	} catch (e) {
		console.error(
			`[copilot-daemon] Failed to load copilot.yaml: ${(e as Error).message}`,
		);
		return;
	}

	// The copilot agent ID is defined by the team config (e.g. "copilot").
	// It is the `to` field value in mailbox messages, which is stable regardless
	// of which missionId is used for test isolation.
	const agentId = teamConfig.agents[0]?.id ?? "copilot";

	// Patch teamConfig.mission.id so runAgent uses the resolved missionId
	// (which may be overridden for test isolation).
	const effectiveTeamConfig =
		missionId !== teamConfig.mission.id
			? { ...teamConfig, mission: { ...teamConfig.mission, id: missionId } }
			: teamConfig;

	const identity = copilotIdentityFor(missionId);
	provisionCopilotSkills(repoRoot, identity.workdir);

	console.log("[copilot-daemon] Ready — watching for operator messages");

	let readySignaled = false;
	let failedTurns = 0;

	while (!signal.aborted) {
		// Drain any messages that arrived while the previous turn was running.
		const hasUnread = await mailboxRepo.hasUnread(agentId).catch(() => false);
		if (hasUnread && !readySignaled) {
			readySignaled = true;
			onReady();
		}
		if (!hasUnread) {
			// Fire onReady once the Change Stream is open so callers know it is
			// safe to post messages without missing the insert event.
			const notifyOnce = readySignaled
				? undefined
				: () => {
						readySignaled = true;
						console.log("[copilot-daemon] stream open, signaling ready");
						onReady();
					};
			// Bound the wait: derive a per-iteration signal that aborts on either
			// real shutdown or the poll-fallback timer. waitForMailboxInsert
			// resolves (not rejects) on abort either way, closing its stream; the
			// listUnread() call below then re-checks for real, catching anything
			// the stream missed.
			const iterAc = new AbortController();
			const forwardAbort = () => iterAc.abort();
			signal.addEventListener("abort", forwardAbort, { once: true });
			const pollTimer = setTimeout(() => iterAc.abort(), POLL_FALLBACK_MS);
			try {
				await waitForMailboxInsert(
					mailboxCol,
					missionId,
					iterAc.signal,
					notifyOnce,
				);
			} catch (e) {
				if (signal.aborted) break;
				const backoffMs = 2_000;
				console.error(
					`[copilot-daemon] Change Stream error: ${(e as Error).message}. Retrying in ${backoffMs}ms`,
				);
				await sleepMs(backoffMs, signal);
				continue;
			} finally {
				clearTimeout(pollTimer);
				signal.removeEventListener("abort", forwardAbort);
			}
		}

		if (signal.aborted) break;

		const messages = await mailboxRepo.listUnread(agentId).catch(() => []);
		if (messages.length === 0) continue;

		console.log(
			`[copilot-daemon] Starting turn (${messages.length} message(s))`,
		);
		try {
			const ctx: AgentRunContext = {
				model,
				teamConfig: effectiveTeamConfig,
				mailboxRepo,
				conversationRepo,
				llmCallLog,
				statsCollector,
				identity,
				onUserMessage: (msg) => pushEvent("copilot-msg", msg),
				onMessage: async (msg: Message) => {
					pushEvent("copilot-loop-msg", msg);
					// Surface LLM errors (budget exhausted, overloaded, etc.) to the
					// Fly log and the copilot chat UI — these would otherwise be silent.
					if (msg.role === "assistant") {
						const am = msg as AssistantMessage;
						if (am.stopReason === "error") {
							const errorMessage = am.errorMessage ?? "LLM error (no details)";
							console.error(`[copilot-daemon] LLM error: ${errorMessage}`);
							pushEvent("copilot-error", { errorMessage });
						}
					}
				},
				onMentalMapUpdate: (_agentId, html) =>
					pushEvent("copilot-mental-map", html),
				additionalTools: createCopilotTools(
					db,
					pushEvent,
					pending,
					missionId.startsWith("copilot-")
						? missionId.slice("copilot-".length)
						: missionId,
				),
			};
			busyRef.current = true;
			await runAgent(agentId, messages, ctx, signal);
			// Marked read only after the turn: a crash, redeploy or abort
			// mid-turn used to lose the operator's message silently (at-most-
			// once, audit CD1). Now it is retried — at least once.
			await markTurnRead(mailboxRepo, agentId, messages);
			failedTurns = 0;
			console.log("[copilot-daemon] Turn complete");
		} catch (e) {
			if (!signal.aborted) {
				const errorMessage = (e as Error).message;
				failedTurns++;
				const backoffMs = turnFailureBackoffMs(failedTurns, errorMessage);
				console.error(
					`[copilot-daemon] Turn error (attempt ${failedTurns}): ${errorMessage} — retrying in ${Math.round(backoffMs / 1000)} s`,
				);
				pushEvent("copilot-error", { errorMessage });
				await sleepMs(backoffMs, signal);
			}
		} finally {
			busyRef.current = false;
			// Push updated usage totals so the UI cost indicator stays current.
			const [agg] = await db
				.collection("llmCallLog")
				.aggregate([
					{ $match: { missionId } },
					{
						$group: {
							_id: null,
							calls: { $sum: 1 },
							inputTokens: { $sum: "$usage.inputTokens" },
							outputTokens: { $sum: "$usage.outputTokens" },
							cacheReadTokens: { $sum: "$usage.cacheReadTokens" },
							costUsd: { $sum: "$usage.cost.totalCostUsd" },
						},
					},
				])
				.toArray()
				.catch(() => []);
			if (agg) pushEvent("copilot-usage", agg);
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForMailboxInsert(
	mailboxCol: Collection,
	missionId: string,
	signal: AbortSignal,
	onStreamOpen?: () => void,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const stream = mailboxCol.watch(
			[
				{
					$match: {
						operationType: "insert",
						"fullDocument.missionId": missionId,
					},
				},
			],
			{ fullDocument: "updateLookup" },
		);
		// Tells callers that watch() has been *called*; the stream may not yet be
		// open server-side, so an insert landing in that window is only caught by
		// the next poll-fallback iteration (audit CD2).
		onStreamOpen?.();
		const onAbort = () => {
			stream.close().catch(() => {});
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		stream.once("change", () => {
			signal.removeEventListener("abort", onAbort);
			stream.close().catch(() => {});
			resolve();
		});
		stream.once("error", (err: Error) => {
			signal.removeEventListener("abort", onAbort);
			reject(err);
		});
	});
}

async function markTurnRead(
	mailboxRepo: { markRead: (ids: string[], agentId: string) => Promise<void> },
	agentId: string,
	messages: Array<{ id: string }>,
): Promise<void> {
	await mailboxRepo
		.markRead(
			messages.map((m) => m.id),
			agentId,
		)
		.catch((err: Error) =>
			console.error(
				`[copilot-daemon] failed to mark ${messages.length} message(s) read: ${err.message} — they will be re-delivered`,
			),
		);
}

/**
 * How long to wait before retrying a failed copilot turn: exponential from
 * 30 s to 5 min, or the provider's own `Retry-After` when the error carries
 * one — a tight retry loop once produced 42 failed turns in 40 s (2026-09-21).
 */
export function turnFailureBackoffMs(
	failedTurns: number,
	errorMessage: string,
): number {
	const exp = Math.min(30_000 * 2 ** Math.max(0, failedTurns - 1), 300_000);
	const m = errorMessage.match(/Retry-After\D{0,8}(\d{1,5})/i);
	const retryAfterMs = m ? Number(m[1]) * 1000 : 0;
	return Math.max(exp, Math.min(retryAfterMs, 600_000));
}

async function sleepMs(ms: number, signal: AbortSignal): Promise<void> {
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}
