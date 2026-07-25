/**
 * Structured mission config — the write side + append-only revision log
 * (ADR-0021).
 *
 * `missions.mission`/`missions.agents`/`missions.missionCopilotLimits` are the
 * live, structured source of truth for a mission's config (superseding
 * `teamConfigYaml`). Every write path that changes them — the cockpit's
 * `PUT /:id/config`, `PATCH /:id/limits/*`, the mission copilot's
 * `SaveMissionConfig`/`SetMissionSpendCap` tools, and the control-plane
 * copilot's `save_session_config` action — shares this one helper instead of
 * five independent copies of "read current, apply a patch, $set, done." Each
 * caller resolves its own next-state snapshot (a single-field patch, a
 * upsert-by-id merge, or a wholesale replace — those differ per caller and
 * stay in the caller); this helper's job is only to commit it: one $set on
 * `missions` and one append to `missionConfigRevisions`.
 *
 * `missionConfigRevisions` stores only the post-write `config` snapshot per
 * document, never a before/after pair — edit N's snapshot is edit N+1's
 * implicit "before," so the ordered sequence of documents already is the
 * full history, with no redundant duplication and no upsert-shaped
 * ambiguity about which value is current.
 */

import type { AgentConfig, Limits, TeamConfig } from "@magi/agent-config";
import type { Db } from "mongodb";

export interface MissionConfigSnapshot {
	mission: TeamConfig["mission"];
	agents: AgentConfig[];
	missionCopilotLimits?: Limits;
}

export interface MissionConfigRevisionDoc extends MissionConfigSnapshot {
	missionId: string;
	at: Date;
	/** "user" | an agentId | "copilot" | "migration" — free text, not an enum. */
	by: string;
}

export interface MissionConfigWriter {
	/**
	 * Commit a new structured config snapshot for a mission: $sets
	 * `missions`'s `mission`/`agents`/`missionCopilotLimits` fields and
	 * appends one `missionConfigRevisions` document capturing the same
	 * snapshot. Does not validate — callers validate via `parseTeamConfig`
	 * before calling this, since only they know the right error-surfacing
	 * behavior (HTTP 400, tool error string, etc.) for their own caller.
	 */
	write(
		missionId: string,
		snapshot: MissionConfigSnapshot,
		by: string,
	): Promise<void>;
}

export function createMongoMissionConfigWriter(db: Db): MissionConfigWriter {
	const missions = db.collection("missions");
	const revisions = db.collection<MissionConfigRevisionDoc>(
		"missionConfigRevisions",
	);

	// Primary access pattern: a mission's revision history in time order.
	revisions
		.createIndex({ missionId: 1, at: 1 })
		.catch((e: unknown) =>
			console.warn(
				"[mission-config-revisions] Failed to create missionId/at index:",
				(e as Error).message,
			),
		);

	return {
		async write(missionId, snapshot, by) {
			const now = new Date();
			// write() always receives the complete desired state (every caller
			// re-validates a full TeamConfig before calling this), so an
			// undefined missionCopilotLimits means "no limits configured," not
			// "leave whatever's there." $set never clears a field it doesn't
			// mention — even with connectMongo()'s ignoreUndefined:true — so an
			// actual $unset is required to make that distinction land, e.g. when
			// an operator clears the mission-copilot's limits via the Limits panel.
			await missions.updateOne(
				{ missionId },
				{
					$set: {
						mission: snapshot.mission,
						agents: snapshot.agents,
						updatedAt: now,
						...(snapshot.missionCopilotLimits !== undefined
							? { missionCopilotLimits: snapshot.missionCopilotLimits }
							: {}),
					},
					...(snapshot.missionCopilotLimits === undefined
						? { $unset: { missionCopilotLimits: "" } }
						: {}),
				},
			);
			await revisions.insertOne({
				missionId,
				at: now,
				by,
				mission: snapshot.mission,
				agents: snapshot.agents,
				missionCopilotLimits: snapshot.missionCopilotLimits,
			});
		},
	};
}
