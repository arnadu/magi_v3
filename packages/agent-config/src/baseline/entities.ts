import { defineEntity } from "./define-entity.js";
import { LLM_CALL, TURN, WORK_ITEM } from "./entities-record.js";
import { RESOURCE_ENTITIES } from "./entities-resources.js";

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
			enforcedBy: [],
			decidedBy: "ADR-0034",
		},
		{
			id: "mission.way-out",
			text: "Whatever state a mission is in, the operator can get it out of that state from the cockpit: no state is a dead end.",
			enforcedBy: [],
		},
		{
			id: "mission.work-kept",
			text: "A mission's volume (its work) survives every transition. Missions are not deleted: suspend is the end state until archive exists (decision D-6); archive will stop all costs and keep the results readable.",
			enforcedBy: [],
		},
		{
			id: "mission.status-follows-machine",
			text: "The status the cockpit shows is the machine's real state: when a machine stops or fails on its own, the platform notices on a timer and updates the status (`mission.reconcile`). Looking at a mission never changes it.",
			enforcedBy: [],
		},
	],
	notes:
		"A draft is a mission in state `draft`, until editable templates replace drafts: a mission will then start at `provisioning`. Budget pause is not a mission state: the mission keeps running and dispatches nothing until the cap is raised above the spend (see `mission.set-spend-cap`).",
});

const agent = defineEntity({
	id: "agent",
	name: "Agent (within a mission), and the copilots",
	store: {
		kind: "other",
		where:
			"The mission's configuration (`agents`, the roster) and the daemon's dispatch state",
	},
	states: [
		{
			id: "idle",
			meaning: "No turn running; dispatched when it has unread mail",
		},
		{ id: "running", meaning: "A turn is running" },
		{ id: "paused", meaning: "Never dispatched until resumed" },
		{
			id: "cooling-down",
			meaning:
				"Its last turn ended on a model error; not dispatched until the cooldown ends",
		},
		{
			id: "held",
			meaning:
				"The mission's spend has reached its cap; not dispatched until the cap is raised",
		},
	],
	transitions: [
		{
			from: "idle",
			event: "dispatched: unread mail, within budget",
			to: "running",
			actors: ["PLT"],
		},
		{ from: "running", event: "turn ends", to: "idle", actors: ["PLT"] },
		{
			from: "running",
			event: "turn ends on a model error",
			to: "cooling-down",
			actors: ["PLT"],
		},
		{
			from: "cooling-down",
			event: "cooldown ends",
			to: "idle",
			actors: ["PLT"],
			note: "Dispatched again without new mail if mail is still unread",
		},
		{
			from: "idle",
			event: "the mission's spend reaches its cap",
			to: "held",
			actors: ["PLT"],
		},
		{
			from: "held",
			event: "the cap is raised above the spend",
			to: "idle",
			actors: ["OP", "CC", "MC"],
			note: "Through `mission.set-spend-cap`",
		},
		{
			from: "idle",
			event: "pause",
			to: "paused",
			actors: ["OP", "CC", "MC"],
		},
		{
			from: "running",
			event: "pause",
			to: "paused",
			actors: ["OP", "CC", "MC"],
			note: "The running turn finishes; no next turn",
		},
		{
			from: "paused",
			event: "resume",
			to: "idle",
			actors: ["OP", "CC", "MC"],
		},
	],
	invariants: [
		{
			id: "agent.one-turn",
			text: "An agent runs at most one turn at a time.",
			enforcedBy: [],
		},
		{
			id: "agent.turn-ends",
			text: "Every turn ends, within the agent's limits and a wall-clock timeout.",
			enforcedBy: [],
		},
		{
			id: "agent.within-budget",
			text: "No turn starts once the mission's spend has reached its cap.",
			enforcedBy: [],
		},
		{
			id: "agent.pause-holds",
			text: "A pause holds until someone resumes the agent, across any restart of the mission (resume, upgrade, crash).",
			enforcedBy: [],
		},
		{
			id: "agent.no-teammate-control",
			text: "Agents never act on a teammate. A supervisor agent works with the agents it oversees through the mailbox only.",
			enforcedBy: [],
		},
	],
	notes:
		"The agent loop is the operations `agent.dispatch`, `agent.turn` and `agent.reflect`. A turn's work is the agent's tool calls, each an operation of its own. The copilots are agents with privileged access; the control copilot belongs to no mission, runs on the control plane and is stored there.",
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
			enforcedBy: [],
		},
		{
			id: "schedule.roster",
			text: "Recipients are on the mission's roster.",
			enforcedBy: [],
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
		{ id: "cancelled", meaning: "Stopped on request while running" },
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
		{
			from: "running",
			event: "cancel",
			to: "cancelled",
			actors: ["MC"],
			note: "The operator is told",
		},
		{
			from: null,
			event: "restart a failed or cancelled job, as a new job",
			to: "pending",
			actors: ["MC"],
			note: "Same script and author as the original",
		},
	],
	invariants: [
		{
			id: "job.as-author",
			text: "A job runs as its author, with no secrets, whether its author submitted it or scheduled it; a job schedule names only its author.",
			enforcedBy: [],
			decidedBy: "ADR-0033",
		},
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
			id: "objective.well-formed",
			text: "Objectives and their tasks form one tree (no duplicate ids, unknown parents or cycles), and each is changed only by those entitled to: the objective tree by the copilots; a task by its assignee, its creator, the objective's owner or the mission copilot.",
			enforcedBy: [],
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
			id: "task.done-checked",
			text: "A task with a finish line is completed only when it is met: its check script, run as the agent completing it, passes; or, without a check, the completion note says how. Only the operator or the mission copilot may complete it otherwise, and the reason is recorded.",
			enforcedBy: [
				{
					kind: "runtime",
					where:
						"agent-runtime-worker/src/objectives/work-order.ts: completionNote, runCheck (called by UpdateTask)",
				},
				{ kind: "test" },
			],
			decidedBy: "ADR-0038",
		},
		{
			id: "task.terms-guarded",
			text: "A task's finish line, check and required skills are set by whoever assigned it (its creator, its objective's owner or the mission copilot), never by an assignee alone; its check script and required skills come only from the team and platform skills, which agents cannot write, and the assignee must have each required skill.",
			enforcedBy: [
				{
					kind: "runtime",
					where:
						"agent-runtime-worker/src/objectives/work-order.ts: termsChangeDenied, requiredSkillsError; agent-runtime-worker/src/agent-runner-work-orders.ts: resolveCheckScript",
				},
				{ kind: "test" },
			],
			decidedBy: "ADR-0038",
		},
	],
	notes:
		"A piece of work under an objective, with an assignee and a status; agents create and update tasks with their objectives tools. A task may be a work order (ADR-0038): instructions, a finish line (`doneWhen`, optionally checked by a script), and the skills it must follow, all shown to the assignee every turn. `objective.well-formed` covers who may change it. Its transitions are not yet specified.",
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
	invariants: [
		{
			id: "message.wakes",
			text: "A message wakes its recipient.",
			enforcedBy: [],
		},
	],
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
	TURN,
	LLM_CALL,
	WORK_ITEM,
	...RESOURCE_ENTITIES,
] as const;

export type EntityId = (typeof ENTITIES)[number]["id"];
