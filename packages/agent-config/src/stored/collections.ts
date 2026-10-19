/**
 * The one place a MongoDB collection name appears in source (tripwire T13).
 * `storedCollection(db, key)` returns the collection typed with its canonical
 * document shape, so a wrong field name fails `tsc` at the call site.
 *
 * A collection typed `Document` here is owned by one module, which declares
 * its document type next to the only code that reads and writes it and takes
 * the name from COLLECTION_NAMES (`db.collection<T>(COLLECTION_NAMES.x)`).
 * A collection read by more than one module gets its canonical type here.
 */

import type { Collection, Db, Document } from "mongodb";
import type { MissionAnomaly } from "./anomalies.js";
import type { ConversationDoc } from "./conversation.js";
import type { LlmCallLogEntry } from "./llm-calls.js";
import type { MailboxMessage } from "./mailbox.js";
import type { MissionDoc } from "./missions.js";
import type {
	MissionResourceSample,
	PlatformResourcesDoc,
} from "./resources.js";
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
	missions: MissionDoc;
	missionConfigRevisions: Document;
	scheduledMessages: ScheduledMessageDoc;
	mailbox: MailboxMessage;
	conversationMessages: ConversationDoc;
	llmCallLog: LlmCallLogEntry;
	agentTurnStats: AgentTurnStats;
	missionStats: MissionStats;
	missionAnomalies: MissionAnomaly;
	objectivesGoals: Document;
	objectivesEvents: Document;
	missionResources: MissionResourceSample;
	platformResources: PlatformResourcesDoc;
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

/**
 * `platformResources` holds one document per kind, keyed by `_id`. The
 * driver's `WithId` erases a union discriminated on `_id`, so each kind is
 * read and written through its own typed view.
 */
export function platformResourceCollection<D extends PlatformResourcesDoc>(
	db: Db,
): Collection<D> {
	return db.collection<D>(COLLECTION_NAMES.platformResources);
}
