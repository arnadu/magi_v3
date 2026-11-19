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
 * Declares a file request (D7): a directory where an actor asks for something
 * by writing a file, at the code that reads it. One directory may serve more
 * than one operation (a schedule file is created, and removed to cancel it).
 * Returns `dir` unchanged; the tags exist for the entry-point scan.
 */
export function entryFile(
	tags: EntryTag | readonly EntryTag[],
	dir: string,
): string {
	void tags;
	return dir;
}

/**
 * Declares the operation a trigger serves: the callback of a timer, a change
 * stream or a cooldown, wrapped where it is registered. Returns `fn`
 * unchanged; the tag exists for the entry-point scan.
 */
export function entryTrigger<F>(tag: EntryTag, fn: F): F {
	void tag;
	return fn;
}
