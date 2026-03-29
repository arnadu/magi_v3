import type { Message } from "@mariozechner/pi-ai";
import type { Db } from "mongodb";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * MAGI-internal message type for reflection summaries.
 * Stored alongside pi-ai messages in conversationMessages but never sent to
 * the LLM verbatim — convertToLlm converts them to user messages.
 */
export interface SummaryMessage {
	role: "summary";
	content: string;
}

export interface StoredMessage {
	/**
	 * Incremented each time runAgent() is called for this agent × mission.
	 * This is the compaction anchor: compact(keepFrom) marks all documents
	 * with turnNumber < keepFrom as compacted (excluded from prompt, retained
	 * for auditability and future RAG-based memory retrieval).
	 */
	turnNumber: number;
	/** Verbatim pi-ai message or a MAGI-internal summary. */
	message: Message | SummaryMessage;
	/**
	 * Set to true for messages produced by the reflection inner loop.
	 * Excluded from load() so they never appear in the agent's prompt context,
	 * but retained in MongoDB for debugging and future UI display.
	 */
	isReflection?: boolean;
	/**
	 * Which LLM call (0-based) within the session produced/preceded this message.
	 * -1 for the task user message (before any LLM call).
	 * undefined for reflection messages.
	 */
	callSeq?: number;
	/**
	 * Snapshot of the agent's mental map HTML at the time of this LLM call.
	 * Only set on AssistantMessage documents.
	 */
	mentalMapHtml?: string;
	/**
	 * Set on sub-loop messages (e.g. Research tool inner loop).
	 * Holds the tool_use block id of the parent tool call that spawned this sub-loop.
	 */
	parentToolUseId?: string;
}

export interface ConversationRepository {
	/** Load all non-compacted messages for this agent on this mission, oldest first. */
	load(agentId: string, missionId: string): Promise<StoredMessage[]>;
	/** Append messages produced in the current turn. */
	append(
		agentId: string,
		missionId: string,
		messages: StoredMessage[],
	): Promise<void>;
	/**
	 * Mark all messages with turnNumber < keepFrom as compacted.
	 * Compacted documents are excluded from load() but kept in MongoDB for
	 * auditability and future RAG-based memory retrieval.
	 */
	compact(agentId: string, missionId: string, keepFrom: number): Promise<void>;
	/**
	 * Return the HTML of the most recently stored mental map for this agent,
	 * or null if none has been saved yet.
	 */
	loadMostRecentMentalMap(agentId: string, missionId: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// MongoDB implementation
// ---------------------------------------------------------------------------

interface ConversationDoc {
	agentId: string;
	missionId: string;
	turnNumber: number;
	seqInTurn: number;
	message: Message | SummaryMessage;
	savedAt: Date;
	/**
	 * Set to true by compact() when reflection has summarised this turn.
	 * Compacted documents are excluded from load() (prompt preparation) but
	 * retained in MongoDB for auditability and future RAG-based retrieval.
	 */
	compacted?: boolean;
	/**
	 * Set to true for messages produced by the reflection inner loop.
	 * Excluded from load() so they never appear in the agent's prompt context,
	 * but retained in MongoDB for debugging and future UI display.
	 */
	isReflection?: boolean;
	/** Which LLM call (0-based) within the session this message belongs to. */
	callSeq?: number;
	/** Mental map HTML snapshot at the time of this LLM call (AssistantMessages only). */
	mentalMapHtml?: string;
	/** Parent tool_use block id for sub-loop messages. */
	parentToolUseId?: string;
}

export function createMongoConversationRepository(
	db: Db,
): ConversationRepository {
	const col = db.collection<ConversationDoc>("conversationMessages");

	// Unique compound index — enforces exactly one message per position.
	// Idempotent; safe to call on every startup.
	col
		.createIndex(
			{ agentId: 1, missionId: 1, turnNumber: 1, seqInTurn: 1 },
			{ unique: true },
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
				.find({
					agentId,
					missionId,
					compacted: { $ne: true },
					isReflection: { $ne: true },
				})
				.sort({ turnNumber: 1, seqInTurn: 1 })
				.toArray();
			return docs.map((d) => ({
				turnNumber: d.turnNumber,
				message: d.message,
				...(d.callSeq !== undefined ? { callSeq: d.callSeq } : {}),
				...(d.mentalMapHtml !== undefined ? { mentalMapHtml: d.mentalMapHtml } : {}),
				...(d.parentToolUseId !== undefined ? { parentToolUseId: d.parentToolUseId } : {}),
			}));
		},

		async append(agentId, missionId, messages) {
			if (messages.length === 0) return;
			// seqInTurn is computed by counting existing documents for the turn, then
			// inserting. This count-then-insert is non-atomic, but correctness relies
			// on the invariant that append() is never called concurrently for the same
			// (agentId, missionId, turnNumber). The inner loop serialises all onMessage
			// callbacks, so this invariant holds. The unique index on
			// (agentId, missionId, turnNumber, seqInTurn) provides a safety net: a
			// concurrent duplicate would fail loudly rather than silently corrupt order.
			for (const sm of messages) {
				const seqInTurn = await col.countDocuments({
					agentId,
					missionId,
					turnNumber: sm.turnNumber,
				});
				await col.insertOne({
					agentId,
					missionId,
					turnNumber: sm.turnNumber,
					seqInTurn,
					message: sm.message,
					savedAt: new Date(),
					...(sm.isReflection ? { isReflection: true } : {}),
					...(sm.callSeq !== undefined ? { callSeq: sm.callSeq } : {}),
					...(sm.mentalMapHtml !== undefined ? { mentalMapHtml: sm.mentalMapHtml } : {}),
					...(sm.parentToolUseId !== undefined ? { parentToolUseId: sm.parentToolUseId } : {}),
				});
			}
		},

		async compact(agentId, missionId, keepFrom) {
			await col.updateMany(
				{ agentId, missionId, turnNumber: { $lt: keepFrom } },
				{ $set: { compacted: true } },
			);
		},

		async loadMostRecentMentalMap(agentId, missionId) {
			const doc = await col.findOne(
				{ agentId, missionId, mentalMapHtml: { $exists: true } },
				{ sort: { turnNumber: -1, seqInTurn: -1 } },
			);
			return (doc?.mentalMapHtml) ?? null;
		},
	};
}
