import type { ActorId } from "./actors.js";
import type { ComponentId } from "./components.js";
import type { Operation } from "./types.js";

function defineOperations<const O extends string>(
	ops: readonly Operation<O, ActorId, ComponentId>[],
): readonly Operation<O, ActorId, ComponentId>[] {
	return ops;
}

/**
 * What actors can ask MAGI to do. Each operation has one implementation (its
 * home); every entry point serving it calls that home and adds only who may
 * ask and how the result is shown.
 */
export const OPERATIONS = defineOperations([
	// ── Missions ────────────────────────────────────────────────────────────
	{
		id: "mission.create-draft",
		group: "missions",
		intent: "Start a mission as an editable draft",
		actors: ["OP", "CC"],
		home: "cp-mission-ops",
		rules: ["Valid id, owned by the requester", "Nothing runs"],
	},
	{
		id: "mission.edit-draft",
		group: "missions",
		intent: "Change a draft before launch",
		actors: ["OP", "CC"],
		home: "cp-mission-ops",
		rules: [
			"Validated as a launch would validate it",
			"A write based on an outdated version is refused",
		],
	},
	{
		id: "mission.launch",
		group: "missions",
		intent: "Start a draft running",
		actors: ["OP", "CC"],
		home: "cp-mission-ops",
		rules: [
			"Only a draft",
			"Only once, even if asked twice at the same moment",
			"Capped before any machine starts",
			"A failure leaves the mission in `error` with its reason, and no orphaned resources",
		],
	},
	{
		id: "mission.create",
		group: "missions",
		intent: "Create from a template and launch at once",
		actors: ["OP", "CC"],
		home: "cp-mission-ops",
		rules: [
			"The same checks as `mission.create-draft` followed by `mission.launch`",
		],
	},
	{
		id: "mission.suspend",
		group: "missions",
		intent: "Stop a mission's machine, keeping its work",
		actors: ["OP", "CC"],
		home: "cp-mission-ops",
		rules: ["Only a running mission"],
	},
	{
		id: "mission.resume",
		group: "missions",
		intent: "Bring a suspended or failed mission back",
		actors: ["OP", "CC"],
		home: "cp-mission-ops",
		rules: [
			"Works whatever happened to the old machine; on the default machine and the existing volume",
			"For a mission in `error`, CC diagnoses first, then may run this restore on its own, within a recovery budget the platform counts per mission",
			"A failed attempt is never repeated without a new diagnosis",
			"CC hands over to the operator, with its analysis and a plan, when the budget is spent, when it is unsure of the cause, or when the fix would change cost or size, delete anything or touch data",
		],
	},
	{
		id: "mission.reconcile",
		group: "missions",
		intent: "Keep the stored status in step with the machine's actual state",
		actors: ["PLT"],
		home: "cp-mission-ops",
		rules: [
			"On a timer, one home",
			"An unplanned stop becomes `error` with its reason, and the operator is told",
			"Never during a resize or another claimed transition",
			"Reading a mission never changes it",
		],
	},
	{
		id: "mission.wake",
		group: "missions",
		intent: "Start a stopped machine so due work is delivered",
		actors: ["PLT"],
		home: "cp-machines",
		rules: [
			"Wakes a suspended mission too; it stays running",
			"The operator is told what woke it",
		],
	},
	{
		id: "mission.change-config",
		group: "missions",
		intent: "Change a mission's agents, prompts, models, settings or files",
		actors: ["OP", "CC", "MC"],
		home: "undecided",
		rules: [
			"Applied while the mission runs; suspension is a last resort, only for a change that needs all activity stopped (a change of machine size or of the agents roster)",
			"Validated as a launch",
			"A write based on an outdated version is refused",
			"The operator is told what changed",
		],
	},
	{
		id: "mission.set-spend-cap",
		group: "missions",
		intent: "Set the most a mission may spend",
		actors: ["OP", "CC", "MC"],
		home: "cp-mission-ops",
		rules: [
			"Never above the ceiling",
			"Takes effect without a restart",
			"A cap above current spend lifts a budget pause",
			"The operator is told",
		],
	},
	{
		id: "mission.set-ceiling",
		group: "missions",
		intent: "Set the most anyone may set the cap to",
		actors: ["OP", "ADM"],
		home: "cp-mission-ops",
		rules: [
			"OP up to the platform maximum; ADM above it",
			"Not reachable by any copilot or agent",
		],
	},
	{
		id: "mission.archive",
		group: "missions",
		intent: "End a mission: stop all its costs, keep its results readable",
		actors: ["OP"],
		home: "undecided",
		rules: [
			"Until it is built, a mission ends suspended",
			"Missions are not deleted (decision D-6, 2026-09-12)",
		],
		planned: true,
	},
	// ── Work inside a mission ───────────────────────────────────────────────
	{
		id: "message.send",
		group: "work",
		intent: "Give an agent work or information",
		actors: ["OP", "MC", "AG"],
		home: "mm-state",
		rules: ["Recipients on the roster", "Wakes the recipient"],
	},
	{
		id: "schedule.create",
		group: "work",
		intent: "Have a message or job delivered later or repeatedly",
		actors: ["OP", "CC", "MC", "AG"],
		home: "undecided",
		rules: [
			"OP in the cockpit or through CC",
			"The schedule invariants hold (see the schedule entity)",
		],
	},
	{
		id: "schedule.cancel",
		group: "work",
		intent: "Stop a schedule",
		actors: ["OP", "CC", "MC", "AG"],
		home: "undecided",
		rules: [
			"AG: its own schedules only",
			"A cancelled file-backed schedule stays cancelled until its file is removed",
		],
	},
	{
		id: "agent.pause",
		group: "work",
		intent: "Stop one agent's dispatch",
		actors: ["OP", "CC", "MC"],
		home: "undecided",
		rules: [
			"Takes effect before the agent's next turn",
			"Holds across restarts until someone resumes the agent",
			"Agents never pause a teammate",
		],
	},
	{
		id: "agent.resume",
		group: "work",
		intent: "Restart one agent's dispatch",
		actors: ["OP", "CC", "MC"],
		home: "undecided",
		rules: ["Takes effect before the agent's next turn"],
	},
	{
		id: "objectives.edit",
		group: "work",
		intent: "Change the objective tree",
		actors: ["CC", "MC"],
		home: "mm-state",
		rules: ["No duplicate ids, unknown parents or cycles"],
	},
	{
		id: "task.update",
		group: "work",
		intent: "Record progress on a task",
		actors: ["AG", "MC"],
		home: "mm-state",
		rules: ["Assignee, creator, objective owner or MC only"],
	},
	{
		id: "file.write",
		group: "work",
		intent: "Put a file in the mission's shared folder",
		actors: ["OP", "CC", "AG"],
		home: "undecided",
		rules: ["Contained in the shared folder", "No symlink escapes"],
	},
	{
		id: "job.submit",
		group: "work",
		intent: "Run a script in the background",
		actors: ["AG"],
		home: "mm-jobs",
		rules: ["Runs as its author, with no secrets"],
	},
	{
		id: "machine.upgrade",
		group: "work",
		intent: "Run on a bigger machine for a while",
		actors: ["AG", "MC"],
		home: "cp-machines",
		rules: [
			"AG asks through MC",
			"Within the duration and daily caps",
			"Reverted on time",
			"The operator is told",
		],
	},
	{
		id: "issue.file",
		group: "work",
		intent: "Report a bug or idea about MAGI",
		actors: ["CC", "MC"],
		home: "cp-copilot",
		rules: ["Becomes a proposal the operator confirms"],
	},
	{
		id: "image.create",
		group: "work",
		intent: "Make images for the mission's work",
		actors: ["AG"],
		home: "mm-tools",
		rules: ["Within the per-call budget", "Spend counts against the mission"],
	},
	// ── Reads that must agree wherever they are shown ───────────────────────
	{
		id: "mission.status",
		group: "reads",
		intent: "State, machine, reason for an error",
		actors: ["OP", "CC", "MC"],
		home: "undecided",
		rules: ["The same figure wherever it is shown", "Reading never changes it"],
	},
	{
		id: "mission.spend",
		group: "reads",
		intent: "Spend against cap and ceiling",
		actors: ["OP", "CC", "MC"],
		home: "cp-mission-ops",
		rules: [
			"The same figure wherever it is shown: the header, Limits, Objectives, both copilots",
		],
	},
	{
		id: "mission.results",
		group: "reads",
		intent: "Files, messages, objectives' progress",
		actors: ["OP", "CC", "MC"],
		home: "undecided",
		rules: ["The same figure wherever it is shown"],
	},
	// ── Copilot and account ─────────────────────────────────────────────────
	{
		id: "copilot.confirm",
		group: "copilot",
		intent: "Accept a copilot's proposal",
		actors: ["OP"],
		home: "cp-copilot",
		rules: [
			"Carried out once, even if confirmed twice",
			"The proposer is told the outcome",
		],
	},
	{
		id: "copilot.dismiss",
		group: "copilot",
		intent: "Refuse a copilot's proposal",
		actors: ["OP"],
		home: "cp-copilot",
		rules: ["The proposer is told"],
	},
	{
		id: "copilot.settings",
		group: "copilot",
		intent: "Configure one's own copilot",
		actors: ["OP"],
		home: "cp-copilot",
		rules: [],
	},
	{
		id: "copilot.limits",
		group: "copilot",
		intent: "Set one's own copilot's limits",
		actors: ["OP"],
		home: "cp-copilot",
		rules: [],
	},
	{
		id: "session.sign-in",
		group: "copilot",
		intent: "Start using the cockpit",
		actors: ["OP"],
		home: "cp-edge",
		rules: [],
	},
	{
		id: "session.sign-out",
		group: "copilot",
		intent: "Stop using the cockpit",
		actors: ["OP"],
		home: "cp-edge",
		rules: [],
	},
]);

export type OperationId = (typeof OPERATIONS)[number]["id"];
