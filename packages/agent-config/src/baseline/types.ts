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

export type Plane = "control-plane" | "mission-machine" | "browser" | "shared";

export interface Component<C extends string = string> {
	id: C;
	plane: Plane;
	name: string;
	responsibility: string;
	/**
	 * Its place in its plane: a component builds on components of a lower
	 * layer, and an import of a component on the same or a higher layer runs
	 * against the layering (the trace reports it). `config` and `skills` are 0.
	 */
	layer: number;
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

/**
 * How an invariant is kept true. `test`: a test whose title starts with the
 * invariant's id. `scan`: a query in `scripts/trace/ql/`. `runtime`: a check
 * the platform runs while it operates, at `where`: "<package path>: <what>",
 * where <what> starts with the function names or route path that the
 * baseline test checks are still in that file. `review`: judged by a reviewer.
 */
export type Enforcement =
	| { kind: "test" }
	| { kind: "scan"; query: string }
	| { kind: "runtime"; where: string }
	| { kind: "review" };

/** An ADR id, `ADR-NNNN`. */
export type AdrId = `ADR-${number}`;

export interface Invariant {
	/** Stable id, `<entity>.<name>`; a test or check that enforces it names it. */
	id: string;
	text: string;
	/** Empty until something enforces it; the trace lists the unenforced. */
	enforcedBy: readonly Enforcement[];
	/** The ADR that chose it, when adopting it was a choice between alternatives. */
	decidedBy?: AdrId;
	/** A decision still to make before it can be enforced. */
	open?: string;
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
	/**
	 * The value stored in the status field, when it differs from `id`;
	 * `null` when the code stores no distinct value for this state.
	 */
	stored?: string | null;
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

/** What an operation acts on; the operations table is grouped by it. */
export type OperationGroup =
	| "missions"
	| "spend"
	| "agents"
	| "messages"
	| "files"
	| "schedules"
	| "jobs"
	| "objectives"
	| "images"
	| "apps"
	| "copilot"
	| "platform";

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
	/** The component meant to hold the operation's one implementation. */
	home: C;
	/** Rules that hold whoever asks. */
	rules: readonly string[];
	/** A figure shown to its actors: it must agree wherever it is shown, and reading it never changes it. */
	read?: boolean;
	planned?: boolean;
	/**
	 * The operation that starts this one, when no actor asks for it directly
	 * (D8): it needs no entry point of its own, and the trace checks that the
	 * parent's entry points reach its home.
	 */
	startedBy?: O;
}

/**
 * An entry point that serves no product operation. Every entry point declares
 * either the operation it serves or one of these classes.
 */
export interface EntryClass<K extends string = string> {
	id: K;
	what: string;
	/** Why no product operation applies. */
	why: string;
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

/** A MongoDB collection and the one component allowed to write it. */
export interface DataStore<C extends string = string> {
	collection: CollectionKey;
	/** The entity it holds, or what it holds when that is not an entity. */
	holds: string;
	/** The component whose code writes it; every other component reads only. */
	owner: C;
	/** Deliberate exceptions: another component that writes part of it. */
	alsoWrittenBy?: readonly { component: C; what: string }[];
}

/** A service outside MAGI that MAGI depends on. */
export interface ExternalSystem<C extends string = string> {
	id: string;
	name: string;
	usedFor: string;
	/** The components that call it. */
	reachedBy: readonly C[];
}

export interface DependencyRule {
	id: string;
	text: string;
}
