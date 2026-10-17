import type {
	PendingAction,
	PendingActionsStore,
} from "../../src/pending-actions.js";

/** Test double for the Mongo-backed store: same contract, no database. */
export class MemoryPendingActionsStore implements PendingActionsStore {
	readonly store = new Map<string, PendingAction>();
	async add(action: PendingAction): Promise<void> {
		this.store.set(action.id, action);
	}
	async get(id: string): Promise<PendingAction | undefined> {
		return this.store.get(id);
	}
	async take(id: string): Promise<PendingAction | undefined> {
		const a = this.store.get(id);
		this.store.delete(id);
		return a;
	}
	async delete(id: string): Promise<void> {
		this.store.delete(id);
	}
	async listForUser(userId: string): Promise<PendingAction[]> {
		return [...this.store.values()].filter((a) => a.userId === userId);
	}
}
