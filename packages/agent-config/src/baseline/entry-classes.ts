import type { EntryClass } from "./types.js";

function defineEntryClasses<const K extends string>(
	classes: readonly EntryClass<K>[],
): readonly EntryClass<K>[] {
	return classes;
}

/**
 * Entry points that serve no product operation. Adding a class is a baseline
 * change the product owner approves, like adding an operation.
 */
export const ENTRY_CLASSES = defineEntryClasses([
	{
		id: "infrastructure",
		what: "Health check, the browser's client configuration, CSP violation reports",
		why: "Serve the platform's hosting and the browser, not an actor's request",
	},
	{
		id: "developer",
		what: "Run controls of the local dashboard (start, step, stop)",
		why: "Local development only; the cockpit does not use them",
	},
	{
		id: "sub-agent",
		what: "Tools inside a sub-agent that an agent's tool call starts",
		why: "They act within the calling operation, on the agent's behalf and within its budget",
	},
	{
		id: "feed",
		what: "Keepalives and change feeds that push updates to the open event streams of a route",
		why: "Part of the route they serve, which declares the operation",
	},
	{
		id: "housekeeping",
		what: "Evicting idle sessions, pruning old records",
		why: "Keep the platform's own resources bounded; no actor asks for them",
	},
	{
		id: "retired",
		what: "An entry point kept only to refuse a request the product no longer supports",
		why: "It must answer with a refusal rather than disappear",
	},
]);

export type EntryClassId = (typeof ENTRY_CLASSES)[number]["id"];
