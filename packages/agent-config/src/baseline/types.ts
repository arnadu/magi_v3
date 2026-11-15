/**
 * The shapes of the product and architecture baselines: what MAGI is meant
 * to be, as data. Scripts and tests read these; the documents under
 * `docs/product/` and `docs/architecture/` are rendered from them.
 */

import type { CollectionKey } from "../stored/collections.js";

/** An approval state shared by every baseline: changes are approved by the product owner. */
export type BaselineStatus = "draft" | "approved";

export interface Actor<A extends string = string> {
	id: A;
	name: string;
	/** What it may do. */
	authority: string;
	/** How it reaches the code; the entry-point scan derives an actor from this. */
	reachesThrough: string;
}

export type Plane = "control-plane" | "mission-machine" | "shared";

export interface Component<C extends string = string> {
	id: C;
	plane: Plane;
	name: string;
	responsibility: string;
	/** Directory the path patterns are relative to, from the repository root. */
	root: string;
	/**
	 * Patterns relative to `root`. `dir/` owns everything under that
	 * directory; `**` owns the whole root; otherwise a glob (`*` = any run of
	 * characters except `/`) matched against the file's path under `root`.
	 * Every source file under a root matches exactly one pattern of one
	 * component (tests excluded).
	 */
	paths: readonly string[];
}

export interface Invariant {
	/** Stable id, `<entity>.<name>`; a test or check that enforces it names it. */
	id: string;
	text: string;
}

/** Where an entity's state is kept: the join with the code for status-write scans. */
export type EntityStore =
	| {
			kind: "collection";
			collection: CollectionKey;
			/** The canonical document type: in `src/stored/` when more than one module reads it, otherwise next to its only owner. */
			type: string;
			/** Field holding the state, when the state is stored as one field. */
			statusField?: string;
	  }
	| { kind: "other"; where: string };

export interface EntityState<S extends string> {
	id: S;
	meaning: string;
	/** Intended but not built yet. */
	planned?: boolean;
}

export interface Transition<S extends string, A extends string> {
	/** `null` = the entity does not exist yet. */
	from: S | null;
	event: string;
	to: S;
	actors: readonly A[];
	note?: string;
}

export interface Entity<
	E extends string = string,
	S extends string = string,
	A extends string = string,
> {
	id: E;
	name: string;
	store: EntityStore;
	states: readonly EntityState<S>[];
	transitions: readonly Transition<S, A>[];
	invariants: readonly Invariant[];
	notes?: string;
}

export type OperationGroup = "missions" | "work" | "reads" | "copilot";

export interface Operation<
	O extends string = string,
	A extends string = string,
	C extends string = string,
> {
	id: O;
	group: OperationGroup;
	/** What is asked for (a change), or the figure shown (a read). */
	intent: string;
	actors: readonly A[];
	/**
	 * The component meant to hold the operation's one implementation;
	 * "undecided" is an open question for the architect.
	 */
	home: C | "undecided";
	/** Rules that hold whoever asks. */
	rules: readonly string[];
	planned?: boolean;
}

export interface Journey<
	J extends string = string,
	A extends string = string,
	O extends string = string,
> {
	id: J;
	title: string;
	actors: readonly A[];
	operations: readonly O[];
	note?: string;
}

export interface DependencyRule {
	id: string;
	text: string;
}
