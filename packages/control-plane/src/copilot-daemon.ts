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
	createMongoConversationRepository,
	createMongoLlmCallLogRepository,
	createMongoMailboxRepository,
	type LlmCallLogRepository,
	type Message,
	resolveModel,
	runAgent,
} from "@magi/agent-runtime-worker";
import type { Collection, Db } from "mongodb";
import type { PendingActionsStore } from "./copilot-tools.js";
import { createCopilotTools } from "./copilot-tools.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const COPILOT_MISSION_ID = "copilot";

const COPILOT_WORKDIR = "/home/magi-copilot/workdir";

/**
 * Upper bound on how long the watch loop waits on a single Change Stream
 * subscription before falling back to re-checking for unread mail directly.
 * A Change Stream can miss the one insert it's meant to catch (e.g. a message
 * posted in the narrow window before the stream is fully open server-side) —
 * without this, a missed event leaves the daemon waiting forever on an event
 * that already happened, i.e. silently unresponsive. See runWatchLoop.
 */
const POLL_FALLBACK_MS = 15_000;

const COPILOT_IDENTITY: AgentIdentity = {
	workdir: COPILOT_WORKDIR,
	sharedDir: COPILOT_WORKDIR,
	linuxUser: "magi-copilot",
};

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

export interface CopilotDaemonHandle {
	stop(): void;
	/** Resolves when the watch loop has opened its first Change Stream and is ready to receive messages. */
	ready: Promise<void>;
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

	runWatchLoop(
		db,
		repoRoot,
		modelId,
		pushEvent,
		pending,
		signal,
		resolvedMissionId,
		resolveReady,
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
	};
}

// ---------------------------------------------------------------------------
// Skill provisioning
// ---------------------------------------------------------------------------

function provisionCopilotSkills(repoRoot: string): void {
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

	const dest = join(COPILOT_WORKDIR, "skills", "_platform");
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
		const platformSkillsToCopy = ["github-issues", "objectives"];
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
): Promise<void> {
	const mailboxCol = db.collection("mailbox");
	const mailboxRepo = createMongoMailboxRepository(db, missionId);
	const conversationRepo = createMongoConversationRepository(db);
	const llmCallLog: LlmCallLogRepository = createMongoLlmCallLogRepository(db);
	const model = resolveModel(modelId);

	let teamConfig: TeamConfig;
	try {
		// allowReservedCopilotId: this file's own agent is legitimately named
		// "copilot" (its own identity, distinct from the mission-copilot
		// reservation in ADR-0016) — a hardcoded, non-attacker-reachable call
		// site, never a mission's SaveMissionConfig payload.
		teamConfig = loadTeamConfig(
			join(repoRoot, "config", "teams", "copilot.yaml"),
			{ allowReservedCopilotId: true },
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

	provisionCopilotSkills(repoRoot);

	console.log("[copilot-daemon] Ready — watching for operator messages");

	let readySignaled = false;

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
		await mailboxRepo
			.markRead(
				messages.map((m) => m.id),
				agentId,
			)
			.catch(() => {});

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
				identity: COPILOT_IDENTITY,
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
			await runAgent(agentId, messages, ctx, signal);
			console.log("[copilot-daemon] Turn complete");
		} catch (e) {
			if (!signal.aborted) {
				const errorMessage = (e as Error).message;
				console.error(`[copilot-daemon] Turn error: ${errorMessage}`);
				pushEvent("copilot-error", { errorMessage });
			}
		} finally {
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
		// Notify callers that the stream is now open and events will not be missed.
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

async function sleepMs(ms: number, signal: AbortSignal): Promise<void> {
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}
