/**
 * The one place a MongoDB collection name appears in source (tripwire T13).
 * `storedCollection(db, key)` returns the collection typed with its canonical
 * document shape, so a wrong field name fails `tsc` at the call site.
 *
 * A collection whose document type is still `Document` has not been migrated
 * to a canonical type yet (code-quality plan, step 1d).
 */

import type { Collection, Db, Document } from "mongodb";
import type { LlmCallLogEntry } from "./llm-calls.js";
import type { ScheduledMessageDoc } from "./scheduling.js";
import type { AgentTurnStats, MissionStats } from "./stats.js";

export const COLLECTION_NAMES = {
	missions: "missions",
	missionConfigRevisions: "missionConfigRevisions",
	scheduledMessages: "scheduled_messages",
	mailbox: "mailbox",
	conversationMessages: "conversationMessages",
	llmCallLog: "llmCallLog",
	agentTurnStats: "agentTurnStats",
	missionStats: "missionStats",
	missionAnomalies: "missionAnomalies",
	objectivesGoals: "objectivesGoals",
	objectivesEvents: "objectivesEvents",
	missionResources: "missionResources",
	platformResources: "platformResources",
	resourceAlertState: "resourceAlertState",
	resourceSnapshots: "resourceSnapshots",
	machineSegments: "machineSegments",
	copilotPendingActions: "copilotPendingActions",
	users: "users",
} as const;

export type CollectionKey = keyof typeof COLLECTION_NAMES;
export type CollectionName = (typeof COLLECTION_NAMES)[CollectionKey];

export interface StoredDocs {
	missions: Document;
	missionConfigRevisions: Document;
	scheduledMessages: ScheduledMessageDoc;
	mailbox: Document;
	conversationMessages: Document;
	llmCallLog: LlmCallLogEntry;
	agentTurnStats: AgentTurnStats;
	missionStats: MissionStats;
	missionAnomalies: Document;
	objectivesGoals: Document;
	objectivesEvents: Document;
	missionResources: Document;
	platformResources: Document;
	resourceAlertState: Document;
	resourceSnapshots: Document;
	machineSegments: Document;
	copilotPendingActions: Document;
	users: Document;
}

/**
 * Collections whose documents carry `missionId` and belong to one mission:
 * what a full reset of a mission deletes. `missions` itself and
 * `resourceAlertState` (keyed `<missionId>:<category>` in `_id`) are handled
 * separately.
 */
export const PER_MISSION_COLLECTIONS = [
	"mailbox",
	"conversationMessages",
	"llmCallLog",
	"scheduledMessages",
	"missionStats",
	"agentTurnStats",
	"objectivesGoals",
	"objectivesEvents",
	"missionConfigRevisions",
	"missionAnomalies",
	"missionResources",
	"machineSegments",
] as const satisfies readonly CollectionKey[];

export function storedCollection<K extends CollectionKey>(
	db: Db,
	key: K,
): Collection<StoredDocs[K]> {
	return db.collection<StoredDocs[K]>(COLLECTION_NAMES[key]);
}
