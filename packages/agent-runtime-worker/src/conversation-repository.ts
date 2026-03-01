import type { Message } from "@mariozechner/pi-ai";
import type { Db } from "mongodb";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredMessage {
	/**
	 * Incremented each time runAgent() is called for this agent × mission.
	 * This is the compaction anchor: trim(keepFrom) deletes all documents
	 * with turnNumber < keepFrom.
	 */
	turnNumber: number;
	/** Verbatim pi-ai message: UserMessage | AssistantMessage | ToolResultMessage. */
	message: Message;
}

export interface ConversationRepository {
	/** Load all messages for this agent on this mission, oldest first. */
	load(agentId: string, missionId: string): Promise<StoredMessage[]>;
	/** Append messages produced in the current turn. */
	append(
		agentId: string,
		missionId: string,
		messages: StoredMessage[],
	): Promise<void>;
	/** Discard all messages with turnNumber < keepFrom (compaction cut point). */
	trim(agentId: string, missionId: string, keepFrom: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// MongoDB implementation
// ---------------------------------------------------------------------------

interface ConversationDoc {
	agentId: string;
	missionId: string;
	turnNumber: number;
	seqInTurn: number;
	message: Message;
	savedAt: Date;
}

export function createMongoConversationRepository(
	db: Db,
): ConversationRepository {
	const col = db.collection<ConversationDoc>("conversationMessages");

	// Compound index — idempotent, safe to call on every startup.
	col
		.createIndex(
			{ agentId: 1, missionId: 1, turnNumber: 1, seqInTurn: 1 },
			{ background: true },
		)
		.catch((e: unknown) =>
			console.warn(
				"[conversation-repository] Failed to create index:",
				(e as Error).message,
			),
		);

	return {
		async load(agentId, missionId) {
			const docs = await col
				.find({ agentId, missionId })
				.sort({ turnNumber: 1, seqInTurn: 1 })
				.toArray();
			return docs.map((d) => ({
				turnNumber: d.turnNumber,
				message: d.message,
			}));
		},

		async append(agentId, missionId, messages) {
			if (messages.length === 0) return;
			const savedAt = new Date();
			// Group by turnNumber and assign seqInTurn within each group.
			const byTurn = new Map<number, StoredMessage[]>();
			for (const sm of messages) {
				const arr = byTurn.get(sm.turnNumber) ?? [];
				arr.push(sm);
				byTurn.set(sm.turnNumber, arr);
			}
			const docs: ConversationDoc[] = [];
			for (const [turnNumber, sms] of byTurn) {
				for (let i = 0; i < sms.length; i++) {
					docs.push({
						agentId,
						missionId,
						turnNumber,
						seqInTurn: i,
						message: sms[i].message,
						savedAt,
					});
				}
			}
			await col.insertMany(docs);
		},

		async trim(agentId, missionId, keepFrom) {
			await col.deleteMany({
				agentId,
				missionId,
				turnNumber: { $lt: keepFrom },
			});
		},
	};
}
