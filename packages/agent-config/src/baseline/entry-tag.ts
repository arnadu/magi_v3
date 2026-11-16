import type { EntryClassId } from "./entry-classes.js";
import type { OperationId } from "./operations.js";

/**
 * What an entry point serves: the product operation it asks for, or the
 * entry class of an entry point that serves none. Every route, tool, copilot
 * action and trigger declares one; `scripts/trace/entry-points.mjs` reads
 * them and its test fails on an entry point without one.
 */
export type EntryTag = OperationId | EntryClassId;

/**
 * Declares the operation a trigger serves: the callback of a timer, a change
 * stream or a cooldown, wrapped where it is registered. Returns `fn`
 * unchanged; the tag exists for the entry-point scan.
 */
export function entryTrigger<F>(tag: EntryTag, fn: F): F {
	void tag;
	return fn;
}
