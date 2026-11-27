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
	{
		id: "platform.config-in-view",
		text: "Every parameter that changes what a mission does or spends (agents' prompts, tools and skills, limits and caps, schedules, budgets, and the platform's safety bounds such as a sub-agent's time, turn and money caps or a job's time limit) is visible to the operator in the cockpit and editable there, by the operator or through a copilot; none lives only where an agent writes it, or only in code.",
		enforcedBy: [],
		open: "Known gaps (2026-11-27): a work queue's daily and per-item budgets are in the job's arguments, which the agent writes; the sub-agents' defaults (Investigate 5 minutes and $0.50, Research 6 minutes, the turn caps), a job's 30-minute limit and the triage run's 12-minute cut-off are in code or scripts. An inventory of every parameter against this invariant comes with the work that closes them",
	},
	{
		id: "platform.spend-in-view",
		text: "Every cost and usage the platform records is visible to the operator in the cockpit, attributed (mission, agent, turn or background job, and the tool or queue that spent it) and shown against the limit that governs it.",
		enforcedBy: [],
		open: "Known gaps (2026-11-27): a work queue's spend against its daily budget, its backlog and its over-budget items are not shown; a background job's spend is folded into its agent's lifetime cost, with no line of its own; whether the Transcripts tab shows a job's sub-agent steps (turn 0) is unchecked",
	},
];
