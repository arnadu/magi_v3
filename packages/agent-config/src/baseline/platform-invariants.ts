import type { Invariant } from "./types.js";

/** Invariants that hold across entities: the record of what happened, and what survives a restart. */
export const PLATFORM_INVARIANTS: readonly Invariant[] = [
	{
		id: "files.attributed",
		text: "Every change to a mission's files is attributed to an agent and a turn.",
		enforcedBy: [],
	},
	{
		id: "platform.no-memory-only-state",
		text: "Every piece of state that decides what the platform does next (pauses, holds, cooldowns, claims, queued work) is stored, and rebuilt after a restart.",
		enforcedBy: [],
	},
	{
		id: "platform.changes-audited",
		text: "Every change to a mission by the operator, a copilot or the platform (configuration, cap, schedule, pause, machine) is recorded: who, what, when and why.",
		enforcedBy: [],
	},
	{
		id: "platform.failures-surface",
		text: "Every failure that stops work (a crashed turn, a timeout, a failed delivery, a failed provisioning) is recorded with its reason and reaches the operator.",
		enforcedBy: [],
	},
];
