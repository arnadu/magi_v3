/**
 * Proposed-but-unconfirmed copilot actions, persisted in MongoDB
 * (`copilotPendingActions`) so a control-plane redeploy does not drop a
 * card the operator can still see (CP1), and claimed atomically on confirm
 * so a double click cannot execute an action twice.
 */

import { COLLECTION_NAMES } from "@magi/agent-config";
import type { Db } from "mongodb";

export interface PendingAction {
	id: string;
	/** Firebase UID of the user whose copilot proposed this action — the identity it executes as. */
	userId: string;
	type: string;
	/** Server-computed from the validated payload (copilot-actions.ts), never LLM-written. */
	label: string;
	payload: unknown;
	createdAt: Date;
}

export interface PendingActionsStore {
	add(action: PendingAction): Promise<void>;
	get(id: string): Promise<PendingAction | undefined>;
	/** Remove and return the action in one step; `undefined` means someone else already took it. */
	take(id: string): Promise<PendingAction | undefined>;
	delete(id: string): Promise<void>;
	/** Cards to replay into a reconnecting cockpit, oldest first. */
	listForUser(userId: string): Promise<PendingAction[]>;
}

export const PENDING_ACTIONS_COLLECTION =
	COLLECTION_NAMES.copilotPendingActions;
/** A card nobody confirmed in a week is stale: the mission state it was computed against has moved on. */
export const PENDING_ACTION_TTL_SECONDS = 7 * 24 * 3600;

type StoredAction = PendingAction & { _id: string };

export class MongoPendingActionsStore implements PendingActionsStore {
	private readonly col;

	constructor(db: Db) {
		this.col = db.collection<StoredAction>(PENDING_ACTIONS_COLLECTION);
	}

	async ensureIndexes(): Promise<void> {
		await this.col.createIndex(
			{ createdAt: 1 },
			{ expireAfterSeconds: PENDING_ACTION_TTL_SECONDS },
		);
		await this.col.createIndex({ userId: 1, createdAt: -1 });
	}

	async add(action: PendingAction): Promise<void> {
		await this.col.insertOne({ ...action, _id: action.id });
	}

	async get(id: string): Promise<PendingAction | undefined> {
		const doc = await this.col.findOne({ _id: id });
		return doc ? strip(doc) : undefined;
	}

	async take(id: string): Promise<PendingAction | undefined> {
		const doc = await this.col.findOneAndDelete({ _id: id });
		return doc ? strip(doc) : undefined;
	}

	async delete(id: string): Promise<void> {
		await this.col.deleteOne({ _id: id });
	}

	async listForUser(userId: string): Promise<PendingAction[]> {
		const docs = await this.col
			.find({ userId })
			.sort({ createdAt: 1 })
			.limit(50)
			.toArray();
		return docs.map(strip);
	}
}

function strip(doc: StoredAction): PendingAction {
	const { _id, ...rest } = doc;
	return rest;
}
