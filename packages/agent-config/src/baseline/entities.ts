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
function defineEntity<const E extends string, const S extends string>(e: {
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

const mission = defineEntity({
	id: "mission",
	name: "Mission",
	store: {
		kind: "collection",
		collection: "missions",
		type: "MissionDoc",
		statusField: "status",
	},
	states: [
		{
			id: "draft",
			meaning: "An editable configuration; nothing runs, nothing is spent",
		},
		{ id: "provisioning", meaning: "Its machine is being created" },
		{
			id: "running",
			meaning: "Its machine runs; agents are dispatched within the spend cap",
		},
		{
			id: "suspended",
			meaning: "Its machine is stopped on request; its work is kept",
		},
		{
			id: "error",
			meaning:
				"Something failed or the machine stopped without a suspend; the reason is recorded",
		},
		{
			id: "archived",
			meaning: "Ended: no costs, results readable",
			planned: true,
		},
	],
	transitions: [
		{ from: null, event: "create a draft", to: "draft", actors: ["OP", "CC"] },
		{
			from: null,
			event: "create from a template, launching at once",
			to: "provisioning",
			actors: ["OP", "CC"],
		},
		{
			from: "draft",
			event: "launch",
			to: "provisioning",
			actors: ["OP", "CC"],
		},
		{
			from: "provisioning",
			event: "machine started",
			to: "running",
			actors: ["PLT"],
		},
		{
			from: "provisioning",
			event: "provisioning failed",
			to: "error",
			actors: ["PLT"],
		},
		{
			from: "running",
			event: "suspend",
			to: "suspended",
			actors: ["OP", "CC"],
		},
		{ from: "suspended", event: "resume", to: "running", actors: ["OP", "CC"] },
		{
			from: "suspended",
			event: "a schedule falls due",
			to: "running",
			actors: ["PLT"],
			note: "Woken; it stays running, and the operator is told why",
		},
		{
			from: "running",
			event: "temporary upgrade, or its revert",
			to: "running",
			actors: ["MC", "PLT"],
			note: "Machine replaced",
		},
		{
			from: "running",
			event:
				"the machine stopped or disappeared without a suspend (crash, out of memory, provider)",
			to: "error",
			actors: ["PLT"],
			note: "With the reason; the operator is told",
		},
		{
			from: "suspended",
			event: "the machine is found running",
			to: "running",
			actors: ["PLT"],
		},
		{
			from: "running",
			event:
				"upgrade or revert failed and the default machine could not be restored",
			to: "error",
			actors: ["PLT"],
		},
		{
			from: "error",
			event: "resume on the default machine and the existing volume",
			to: "running",
			actors: ["OP", "CC"],
			note: "CC on its own, within its recovery budget",
		},
		{
			from: "suspended",
			event: "archive",
			to: "archived",
			actors: ["OP"],
			note: "Planned",
		},
	],
	invariants: [
		{
			id: "mission.capped",
			text: "A mission never runs without a spend cap, and the cap is never above its ceiling.",
		},
		{
			id: "mission.way-out",
			text: "Every state has a way out that the operator can reach from the cockpit.",
		},
		{
			id: "mission.work-kept",
			text: "A mission's volume (its work) survives every transition. Missions are not deleted: suspend is the end state until archive exists (decision D-6); archive will stop all costs and keep the results readable.",
		},
		{
			id: "mission.status-follows-machine",
			text: "The stored status follows the machine's actual state, kept in step by the platform on a timer (`mission.reconcile`), never by reading a mission.",
		},
		{
			id: "mission.error-recovery",
			text: "A mission in `error` is recovered by the control copilot within a budget the platform enforces; beyond it, the copilot hands over to the operator. See `mission.resume`.",
		},
	],
	notes:
		"A draft is a mission in state `draft`. Budget pause is not a mission state: the mission keeps running and dispatches nothing until the cap is raised above the spend (see `mission.set-spend-cap`).",
});

const agent = defineEntity({
	id: "agent",
	name: "Agent (within a mission)",
	store: { kind: "other", where: "The mission's configuration (`agents`)" },
	states: [
		{ id: "active", meaning: "Dispatched when it has work" },
		{ id: "paused", meaning: "Never dispatched until resumed" },
	],
	transitions: [
		{
			from: "active",
			event: "pause",
			to: "paused",
			actors: ["OP", "CC", "MC"],
		},
		{
			from: "paused",
			event: "resume",
			to: "active",
			actors: ["OP", "CC", "MC"],
		},
	],
	invariants: [
		{
			id: "agent.pause-holds",
			text: "A pause holds until someone resumes the agent, across any restart of the mission (resume, upgrade, crash).",
		},
		{
			id: "agent.no-teammate-control",
			text: "Agents never act on a teammate. A supervisor agent works with the agents it oversees through the mailbox only.",
		},
	],
});

const schedule = defineEntity({
	id: "schedule",
	name: "Schedule",
	store: {
		kind: "collection",
		collection: "scheduledMessages",
		type: "ScheduledMessageDoc",
		statusField: "status",
	},
	states: [
		{ id: "pending", meaning: "Waiting for its next occurrence" },
		{ id: "delivering", meaning: "Claimed for delivery" },
		{ id: "delivered", meaning: "A one-off, delivered" },
		{ id: "failed", meaning: "Retries exhausted; the operator was told" },
		{ id: "cancelled", meaning: "Stopped on request" },
	],
	transitions: [
		{
			from: null,
			event: "create",
			to: "pending",
			actors: ["OP", "CC", "MC", "AG"],
			note: "OP in the cockpit, or through CC",
		},
		{ from: "pending", event: "falls due", to: "delivering", actors: ["PLT"] },
		{
			from: "delivering",
			event: "delivered, one-off",
			to: "delivered",
			actors: ["PLT"],
		},
		{
			from: "delivering",
			event: "delivered, recurring",
			to: "pending",
			actors: ["PLT"],
			note: "Next occurrence",
		},
		{
			from: "delivering",
			event: "delivery failed, retries left",
			to: "pending",
			actors: ["PLT"],
		},
		{
			from: "delivering",
			event: "retries exhausted",
			to: "failed",
			actors: ["PLT"],
			note: "The operator is told",
		},
		{
			from: "pending",
			event: "cancel",
			to: "cancelled",
			actors: ["OP", "CC", "MC", "AG"],
			note: "AG: its own schedules only",
		},
	],
	invariants: [
		{
			id: "schedule.min-interval",
			text: "A recurring schedule fires at most every 5 minutes, whoever creates it.",
		},
		{ id: "schedule.roster", text: "Recipients are on the mission's roster." },
		{
			id: "schedule.job-author",
			text: "A job schedule runs only as its author.",
		},
	],
	notes: "Either a message to agents or a job to run, one-off or recurring.",
});

const pendingAction = defineEntity({
	id: "pending-action",
	name: "Pending action (a copilot's proposal)",
	store: {
		kind: "collection",
		collection: "copilotPendingActions",
		type: "PendingAction",
	},
	states: [
		{ id: "proposed", meaning: "Waiting for the operator" },
		{ id: "executed", meaning: "Confirmed and carried out" },
		{ id: "failed", meaning: "Confirmed; carrying it out failed" },
		{ id: "dismissed", meaning: "Refused by the operator" },
	],
	transitions: [
		{
			from: null,
			event: "propose",
			to: "proposed",
			actors: ["CC", "MC"],
			note: "MC: issues and resource requests",
		},
		{
			from: "proposed",
			event: "confirm",
			to: "executed",
			actors: ["OP"],
			note: "The proposer is told",
		},
		{
			from: "proposed",
			event: "confirm, execution fails",
			to: "failed",
			actors: ["OP"],
			note: "The proposer is told",
		},
		{
			from: "proposed",
			event: "dismiss",
			to: "dismissed",
			actors: ["OP"],
			note: "The proposer is told",
		},
	],
	invariants: [],
});

const job = defineEntity({
	id: "job",
	name: "Background job",
	store: {
		kind: "other",
		where:
			"Files under `shared/jobs/`; the daemon's private record is authoritative",
	},
	states: [
		{ id: "pending", meaning: "Submitted, not started" },
		{ id: "running", meaning: "Running as its author" },
		{ id: "done", meaning: "Finished" },
		{ id: "failed", meaning: "Finished with an error, or lost" },
	],
	transitions: [
		{
			from: null,
			event: "submit",
			to: "pending",
			actors: ["AG", "PLT"],
			note: "PLT: a job schedule",
		},
		{
			from: "pending",
			event: "started, as its author",
			to: "running",
			actors: ["PLT"],
		},
		{
			from: "running",
			event: "finished",
			to: "done",
			actors: ["PLT"],
			note: "The author is told",
		},
		{
			from: "running",
			event: "finished with an error",
			to: "failed",
			actors: ["PLT"],
			note: "The author is told",
		},
		{
			from: "running",
			event: "daemon restarted, job lost",
			to: "failed",
			actors: ["PLT"],
			note: "A job still running after the restart stays `running`",
		},
	],
	invariants: [
		{ id: "job.as-author", text: "A job runs as its author, with no secrets." },
	],
});

const objective = defineEntity({
	id: "objective",
	name: "Objective",
	store: {
		kind: "collection",
		collection: "objectivesGoals",
		type: "GoalsFile",
	},
	states: [
		{ id: "proposed", meaning: "Suggested, not yet adopted" },
		{ id: "active", meaning: "Being worked on" },
		{ id: "achieved", meaning: "Met" },
		{ id: "abandoned", meaning: "Dropped" },
	],
	transitions: [],
	invariants: [
		{
			id: "objective.tree",
			text: "The objective tree has no duplicate ids, unknown parents or cycles.",
		},
	],
	notes:
		"The objective tree is edited by CC and MC. Its transitions are not yet specified.",
});

const task = defineEntity({
	id: "task",
	name: "Task",
	store: {
		kind: "collection",
		collection: "objectivesEvents",
		type: "TaskEvent",
	},
	states: [
		{ id: "open", meaning: "Not started" },
		{ id: "in-progress", meaning: "Being worked on" },
		{ id: "blocked", meaning: "Waiting on something" },
		{ id: "completed", meaning: "Done" },
		{ id: "deferred", meaning: "Postponed" },
		{ id: "cancelled", meaning: "Dropped" },
	],
	transitions: [],
	invariants: [
		{
			id: "task.who-updates",
			text: "A task is updated by its assignee, its creator, the objective's owner, or MC.",
		},
	],
	notes: "Its transitions are not yet specified.",
});

const message = defineEntity({
	id: "message",
	name: "Message",
	store: { kind: "collection", collection: "mailbox", type: "MailboxMessage" },
	states: [
		{ id: "unread", meaning: "Not yet read by a recipient" },
		{ id: "read", meaning: "Read" },
	],
	transitions: [
		{
			from: null,
			event: "send",
			to: "unread",
			actors: ["OP", "MC", "AG", "PLT"],
			note: "PLT: alerts and audits",
		},
		{
			from: "unread",
			event: "read by the recipient",
			to: "read",
			actors: ["AG", "MC"],
		},
	],
	invariants: [{ id: "message.wakes", text: "A message wakes its recipient." }],
	notes: "Read or unread per recipient.",
});

/** What actors work with, each one's states, and the transitions the product intends. */
export const ENTITIES = [
	mission,
	agent,
	schedule,
	pendingAction,
	job,
	objective,
	task,
	message,
] as const;

export type EntityId = (typeof ENTITIES)[number]["id"];
