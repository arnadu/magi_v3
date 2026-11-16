import type { ActorId } from "./actors.js";
import type {
	Entity,
	EntityState,
	EntityStore,
	Invariant,
	Transition,
} from "./types.js";

/**
 * States are inferred from `states` only; a transition naming a state not
 * declared there fails `tsc`.
 */
export function defineEntity<
	const E extends string,
	const S extends string,
>(e: {
	id: E;
	name: string;
	store: EntityStore;
	states: readonly EntityState<S>[];
	transitions: readonly Transition<NoInfer<S>, ActorId>[];
	invariants: readonly Invariant[];
	notes?: string;
}): Entity<E, S, ActorId> {
	return e;
}
