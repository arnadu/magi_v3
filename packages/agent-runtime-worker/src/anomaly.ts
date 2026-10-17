/**
 * Persisted, mission-scoped log of operational anomalies — Sprint 26c.
 *
 * Unifies several previously-siloed notification paths (limit-rule breaches,
 * agent crashes/timeouts, LLM errors, permanently-failed background jobs,
 * exhausted scheduled-message deliveries, unclean process restarts, and the
 * resource-oversight categories of ADR-0032) into one sink that:
 *   1. Persists the event (`missionAnomalies` — for the cockpit Trace panel
 *      and post-hoc review).
 *   2. Wakes the mission's own copilot via its mailbox, if one is present.
 *   3. For hard-severity anomalies only, relays to the owning user's
 *      control-plane copilot (`copilot-{userId}`). This replaces two prior,
 *      independent direct-post call sites in orchestrator.ts (agent timeout,
 *      dispatch-level crash) plus daemon.ts's onLimitAlert, all of which
 *      posted into a single global "copilot" mailbox gated by a
 *      COPILOT_MISSION_ID env var that was never actually set on
 *      execution-plane machines — dead in production, and a cross-user leak
 *      risk if it ever had been set, since every mission's alerts would have
 *      landed in one shared inbox regardless of which user owned the
 *      mission. See ADR-0020.
 */

import type { Db } from "mongodb";
import {
	createMongoMailboxRepository,
	type MailboxRepository,
} from "./mailbox.js";
import { MISSION_COPILOT_AGENT_ID } from "./mission-copilot.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AnomalyCategory =
	| "limit-breach"
	| "agent-crash"
	| "agent-timeout"
	| "llm-error"
	| "job-failure"
	| "scheduling-failure"
	| "unclean-restart"
	| "reflection-failed"
	// Resource oversight (ADR-0031/0032). The platform-level Atlas storage alert
	// has no mission and is posted straight to the admin copilots' mailboxes
	// instead of going through this recorder.
	| "disk-usage-high"
	| "spend-cap-near"
	| "uncapped-spend"
	| "spend-spike"
	| "upgrade-cap-near"
	| "upgrade-cap-reached"
	| "upgrade-idle"
	| "resize-failure"
	| "oom-suspected"
	// Control-plane mission lifecycle. Distinct from resize-failure (ADR-0031's
	// upgrade/revert path): this covers a plain operator/copilot-initiated
	// resume failing, for any reason (e.g. a drifted `volumeId` — see issue #62).
	| "resume-failure";

export type AnomalySeverity = "hard" | "soft";

export interface MissionAnomaly {
	missionId: string;
	category: AnomalyCategory;
	severity: AnomalySeverity;
	agentId?: string;
	turnNumber?: number;
	message: string;
	createdAt: Date;
}

export interface AnomalyRecorder {
	/**
	 * Persist the anomaly, notify the mission copilot (if present), and — for
	 * severity "hard" only — relay to the control-plane copilot. Never
	 * throws — a failure here must not break the caller's own turn/loop, the
	 * same fail-open posture already established for stats writes.
	 */
	record(anomaly: Omit<MissionAnomaly, "createdAt">): Promise<void>;
}

// ---------------------------------------------------------------------------
// MongoDB implementation
// ---------------------------------------------------------------------------

/** Identical anomalies within this window are relayed once, then summarised when the window closes (FE1, issue-58 flood). */
export const ANOMALY_DEDUPE_WINDOW_MS = 5 * 60_000;

/** The de-duplication key: same mission, agent, category and message shape (digits and hex ids stripped). */
export function anomalyDedupeKey(
	a: Pick<MissionAnomaly, "missionId" | "agentId" | "category" | "message">,
): string {
	const shape = a.message
		.replace(/[0-9a-f]{8,}/gi, "#")
		.replace(/\d+(\.\d+)?/g, "#")
		.slice(0, 160);
	return `${a.missionId}|${a.agentId ?? ""}|${a.category}|${shape}`;
}

interface DedupeEntry {
	suppressed: number;
	firstAt: number;
	timer: ReturnType<typeof setTimeout>;
}

export interface AnomalyRecorderOptions {
	dedupeWindowMs?: number;
	now?: () => number;
}

export function createMongoAnomalyRecorder(
	db: Db,
	mailboxRepo: MailboxRepository,
	missionCopilotAgentId: string | undefined,
	controlPlaneCopilot?: {
		mailboxRepo: MailboxRepository;
		missionId: string; // `copilot-{userId}`
	},
	options: AnomalyRecorderOptions = {},
): AnomalyRecorder {
	const col = db.collection<MissionAnomaly & { _id?: unknown }>(
		"missionAnomalies",
	);
	const windowMs = options.dedupeWindowMs ?? ANOMALY_DEDUPE_WINDOW_MS;
	const now = options.now ?? Date.now;
	// Every anomaly is persisted; only the copilot *notifications* are
	// de-duplicated. A tight failure loop used to put 45 identical hard
	// anomalies into a copilot inbox in 30 s, each costing a copilot turn.
	const recent = new Map<string, DedupeEntry>();

	async function notify(
		anomaly: Omit<MissionAnomaly, "createdAt">,
		suffix = "",
	): Promise<void> {
		if (missionCopilotAgentId) {
			try {
				await mailboxRepo.post({
					missionId: anomaly.missionId,
					from: "system",
					to: [missionCopilotAgentId],
					subject: `Anomaly (${anomaly.severity}): ${anomaly.category}`,
					body: anomaly.message + suffix,
				});
			} catch (e) {
				console.error(
					`[anomaly] Failed to notify mission copilot { missionId: ${anomaly.missionId}, category: ${anomaly.category} }: ${(e as Error).message}`,
				);
			}
		}
		// Coarse cross-mission triage layer only sees hard breaches — every
		// soft blip from every mission would drown out what it's meant to
		// catch (its own prompt says it's a top-level check, not a
		// diagnosis tool; the mission copilot handles the rest).
		if (anomaly.severity === "hard" && controlPlaneCopilot) {
			try {
				await controlPlaneCopilot.mailboxRepo.post({
					missionId: controlPlaneCopilot.missionId,
					from: "system",
					to: ["copilot"],
					subject: `Anomaly (hard): ${anomaly.category} — mission ${anomaly.missionId}`,
					body: `Mission "${anomaly.missionId}": ${anomaly.message}${suffix}`,
				});
			} catch (e) {
				console.error(
					`[anomaly] Failed to relay to control-plane copilot { missionId: ${anomaly.missionId}, category: ${anomaly.category} }: ${(e as Error).message}`,
				);
			}
		}
	}

	function openWindow(
		key: string,
		anomaly: Omit<MissionAnomaly, "createdAt">,
	): void {
		const entry: DedupeEntry = {
			suppressed: 0,
			firstAt: now(),
			timer: setTimeout(() => {
				recent.delete(key);
				if (entry.suppressed > 0) {
					void notify(
						anomaly,
						`\n\n(${entry.suppressed} further identical anomal${entry.suppressed === 1 ? "y" : "ies"} suppressed since ${new Date(entry.firstAt).toISOString()}; all are recorded in missionAnomalies.)`,
					);
				}
			}, windowMs),
		};
		entry.timer.unref?.();
		recent.set(key, entry);
	}

	// Primary access pattern: a mission's anomalies in time order (Trace panel,
	// mission copilot's own investigative tools).
	col
		.createIndex({ missionId: 1, createdAt: 1 })
		.catch((e: unknown) =>
			console.warn(
				"[anomaly] Failed to create missionId/createdAt index:",
				(e as Error).message,
			),
		);

	return {
		async record(anomaly) {
			const doc: MissionAnomaly = { ...anomaly, createdAt: new Date() };
			try {
				await col.insertOne(doc);
			} catch (e) {
				console.error(
					`[anomaly] Failed to persist { missionId: ${anomaly.missionId}, category: ${anomaly.category} }: ${(e as Error).message}`,
				);
			}

			const key = anomalyDedupeKey(anomaly);
			const open = recent.get(key);
			if (open) {
				open.suppressed++;
				return;
			}
			openWindow(key, anomaly);
			await notify(anomaly);
		},
	};
}

/**
 * The recurring "one mission's `AnomalyRecorder`" wiring: the mission's own
 * mailbox for its copilot, plus a relay to the owning user's control-plane
 * copilot (`copilot-{userId}`) for hard severities. Used by every
 * control-plane-side caller that raises an anomaly against a specific mission
 * (resource-upgrade.ts, fly-events.ts, resource-monitor.ts) so this wiring is
 * only ever written once.
 */
export function createMongoAnomalyRecorderForMission(
	db: Db,
	missionId: string,
	userId: string,
): AnomalyRecorder {
	return createMongoAnomalyRecorder(
		db,
		createMongoMailboxRepository(db, missionId),
		MISSION_COPILOT_AGENT_ID,
		{
			mailboxRepo: createMongoMailboxRepository(db, `copilot-${userId}`),
			missionId: `copilot-${userId}`,
		},
	);
}
