import type { Message } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Minimal conversation persistence interface.
 * Intentionally thin — we'll extend it only when the code needs more.
 */
export interface ConversationRepository {
	save(sessionId: string, messages: Message[]): Promise<void>;
	load(sessionId: string): Promise<Message[]>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (used in tests and when no MongoDB URI is set)
// ---------------------------------------------------------------------------

export class InMemoryConversationRepository implements ConversationRepository {
	private readonly store = new Map<string, Message[]>();

	async save(sessionId: string, messages: Message[]): Promise<void> {
		this.store.set(sessionId, [...messages]);
	}

	async load(sessionId: string): Promise<Message[]> {
		return [...(this.store.get(sessionId) ?? [])];
	}
}

// ---------------------------------------------------------------------------
// MongoDB implementation
// ---------------------------------------------------------------------------

/**
 * Connect to MongoDB and return a ConversationRepository backed by the
 * `conversations` collection in the given database.
 *
 * The caller is responsible for eventual client cleanup if needed.
 */
export async function createMongoRepository(
	mongoUri: string,
	dbName = "magi",
): Promise<ConversationRepository> {
	// Dynamic import keeps mongodb out of the module graph when not used
	const { MongoClient } = await import("mongodb");
	const client = new MongoClient(mongoUri);
	await client.connect();
	const collection = client.db(dbName).collection<{
		sessionId: string;
		messages: Message[];
		updatedAt: Date;
	}>("conversations");

	return {
		async save(sessionId, messages) {
			await collection.replaceOne(
				{ sessionId },
				{ sessionId, messages, updatedAt: new Date() },
				{ upsert: true },
			);
		},

		async load(sessionId) {
			const doc = await collection.findOne({ sessionId });
			return (doc?.messages as Message[]) ?? [];
		},
	};
}
