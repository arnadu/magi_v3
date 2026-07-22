/**
 * Persisted, mission-scoped log of operational anomalies — Sprint 26c.
 *
 * Unifies several previously-siloed notification paths (limit-rule breaches,
 * agent crashes/timeouts, LLM errors, permanently-failed background jobs,
 * exhausted scheduled-message deliveries, unclean process restarts) into one
 * sink that:
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
import type { MailboxRepository } from "./mailbox.js";

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
	| "unclean-restart";

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

export function createMongoAnomalyRecorder(
	db: Db,
	mailboxRepo: MailboxRepository,
	missionCopilotAgentId: string | undefined,
	controlPlaneCopilot?: {
		mailboxRepo: MailboxRepository;
		missionId: string; // `copilot-{userId}`
	},
): AnomalyRecorder {
	const col = db.collection<MissionAnomaly & { _id?: unknown }>(
		"missionAnomalies",
	);

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

			if (missionCopilotAgentId) {
				try {
					await mailboxRepo.post({
						missionId: anomaly.missionId,
						from: "system",
						to: [missionCopilotAgentId],
						subject: `Anomaly (${anomaly.severity}): ${anomaly.category}`,
						body: anomaly.message,
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
						body: `Mission "${anomaly.missionId}": ${anomaly.message}`,
					});
				} catch (e) {
					console.error(
						`[anomaly] Failed to relay to control-plane copilot { missionId: ${anomaly.missionId}, category: ${anomaly.category} }: ${(e as Error).message}`,
					);
				}
			}
		},
	};
}
