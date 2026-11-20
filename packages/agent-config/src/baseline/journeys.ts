import type { ActorId } from "./actors.js";
import type { OperationId } from "./operations.js";
import type { Journey } from "./types.js";

function defineJourneys<const J extends string>(
	journeys: readonly Journey<J, ActorId, OperationId>[],
): readonly Journey<J, ActorId, OperationId>[] {
	return journeys;
}

/**
 * The journeys MAGI must support: the goals of an actor, end to end (D10).
 * `J-` journeys are the operator's, with the copilots; `A-` journeys are an
 * agent's. Every operation an operator, a copilot or an agent asks for is in
 * at least one. A journey is verified by walking it for every expected actor:
 * each step reachable, each hand-off reported back, the same result whoever
 * asks. Tests and scenarios that walk one name its id.
 */
export const JOURNEYS = defineJourneys([
	{
		id: "J-01",
		title: "Sign in, see my missions, sign out",
		actors: ["OP"],
		operations: ["session.sign-in", "mission.status", "session.sign-out"],
	},
	{
		id: "J-02",
		title: "Launch a mission from a template",
		actors: ["OP"],
		operations: ["platform.offerings", "template.browse", "mission.launch"],
		note: "Only a unique mission name is asked for (decision 6); `template.browse` when editable templates ship",
	},
	{
		id: "J-21",
		title: "Design a template with the control copilot, then launch it",
		actors: ["OP", "CC"],
		operations: [
			"platform.offerings",
			"template.browse",
			"template.create",
			"template.edit",
			"mission.create-draft",
			"mission.edit-draft",
			"objectives.edit",
			"copilot.ask",
			"copilot.confirm",
			"mission.launch",
		],
		note: "Blank, cloned from a template, or from a running mission. Until editable templates ship, a draft stands for the template",
	},
	{
		id: "J-04",
		title: "Change a running mission, with the copilots",
		actors: ["OP", "CC", "MC"],
		operations: [
			"mission.read-config",
			"mission.change-config",
			"mission.set-spend-cap",
			"agent.pause",
			"agent.resume",
			"mission.suspend",
			"mission.resume",
		],
		note: "`mission.change-config` while it runs; suspend and resume only for a change that needs all activity stopped",
	},
	{
		id: "J-06",
		title: "Schedule recurring work",
		actors: ["OP", "CC", "MC", "AG"],
		operations: [
			"schedule.create",
			"schedule.list",
			"schedule.cancel",
			"mission.wake",
		],
	},
	{
		id: "J-07",
		title: "Browse a mission's files and results, and download them",
		actors: ["OP", "CC", "MC"],
		operations: [
			"file.read",
			"file.download",
			"message.read",
			"objectives.progress",
		],
		note: "Where the mission's work is rendered",
	},
	{
		id: "J-08",
		title:
			"Work with the mission copilot to understand what the agents did and decide what to change",
		actors: ["OP", "MC", "CC"],
		operations: [
			"mission.status",
			"agent.history",
			"message.read",
			"file.read",
			"mission.log",
			"objectives.progress",
			"copilot.ask",
			"copilot.dismiss",
		],
		note: "Then J-04 for the change",
	},
	{
		id: "J-09",
		title:
			"Give the team new work: a message, with files, or a change to the objectives",
		actors: ["OP", "MC"],
		operations: [
			"message.send",
			"file.upload",
			"objectives.edit",
			"task.create",
		],
	},
	{
		id: "J-10",
		title: "Watch and control cost",
		actors: ["OP", "CC", "MC"],
		operations: [
			"spend.report",
			"mission.set-spend-cap",
			"mission.set-ceiling",
		],
	},
	{
		id: "J-11",
		title: "Handle an alert, or recover a mission that is stuck or won't start",
		actors: ["OP", "CC", "MC"],
		operations: [
			"oversight.alert",
			"mission.status",
			"mission.log",
			"mission.repair",
			"mission.resume",
			"message.send",
		],
		note: "`mission.repair` only when the record of the machine or volume is wrong",
	},
	{
		id: "J-13",
		title: "Pause or stop a misbehaving agent, or the whole mission",
		actors: ["OP", "CC", "MC"],
		operations: [
			"agent.history",
			"agent.pause",
			"agent.resume",
			"job.status",
			"job.control",
			"mission.suspend",
		],
	},
	{
		id: "J-14",
		title: "Give a mission more resources",
		actors: ["AG", "MC", "OP"],
		operations: ["machine.upgrade", "machine.reset-upgrade-allowance"],
		note: "An agent asks the mission copilot; the operator resets the allowance once the daily cap is spent",
	},
	{
		id: "J-15",
		title: "Report a bug or idea about MAGI",
		actors: ["OP", "CC", "MC"],
		operations: ["issue.track", "copilot.confirm"],
	},
	{
		id: "J-16",
		title: "Upload a file for the agents",
		actors: ["OP"],
		operations: ["file.upload", "file.write", "message.send"],
	},
	{
		id: "J-17",
		title: "Stop a mission for good",
		actors: ["OP", "CC"],
		operations: ["mission.suspend", "mission.archive"],
		note: "`mission.suspend` today; `mission.archive` when built",
	},
	{
		id: "J-20",
		title: "Track progress against objectives",
		actors: ["OP", "CC", "MC"],
		operations: ["objectives.progress", "task.update", "kpi.record"],
		note: "CC records the KPIs assessed by judgement; MC updates tasks",
	},
	{
		id: "J-22",
		title: "Use a mission's interactive app",
		actors: ["OP", "MC"],
		operations: ["app.status", "app.open", "app.control", "message.send"],
		note: "Planned. Open it from the mission cockpit, or from a copied URL in another tab; ask the team by message to change it",
	},
	{
		id: "A-01",
		title: "Act on a message: read it, do the work, answer",
		actors: ["AG"],
		operations: [
			"message.read",
			"agent.remember",
			"file.write",
			"message.send",
			"task.update",
		],
		note: "The loop of every turn; `agent.dispatch`, `agent.turn` and `agent.reflect` run underneath",
	},
	{
		id: "A-02",
		title: "Research a question",
		actors: ["AG", "SUB"],
		operations: [
			"web.search",
			"web.fetch",
			"web.browse",
			"web.research",
			"agent.shell",
			"file.write",
			"message.send",
		],
	},
	{
		id: "A-03",
		title: "Produce and publish a deliverable",
		actors: ["AG", "SUB"],
		operations: [
			"file.write",
			"image.create",
			"agent.shell",
			"message.send",
			"task.update",
			"kpi.record",
		],
		note: "Publishing is writing it to the shared folder and telling its readers",
	},
	{
		id: "A-04",
		title: "Run work in the background and use its output",
		actors: ["AG", "JOB"],
		operations: [
			"job.submit",
			"job.run",
			"data.query",
			"web.search",
			"web.fetch",
			"message.send",
			"agent.shell",
		],
		note: "The job tells its author when it ends; the agent reads the output",
	},
	{
		id: "A-05",
		title: "Schedule recurring work for itself or its team",
		actors: ["AG"],
		operations: ["schedule.create", "schedule.cancel", "mission.status"],
		note: "By writing and removing schedule files",
	},
	{
		id: "A-06",
		title: "Track its work against the objectives",
		actors: ["AG"],
		operations: ["task.create", "task.update", "kpi.record", "cost.allocate"],
	},
	{
		id: "A-07",
		title: "Lead a team: hand out work and follow it up",
		actors: ["AG"],
		operations: [
			"message.send",
			"message.read",
			"task.create",
			"task.update",
			"mission.status",
		],
		note: "For an agent that supervises others",
	},
	{
		id: "A-08",
		title: "Ask for more resources",
		actors: ["AG", "MC"],
		operations: ["message.send", "machine.upgrade"],
		note: "The agent asks the mission copilot, which decides",
	},
	{
		id: "A-09",
		title: "Keep its memory useful",
		actors: ["AG"],
		operations: ["agent.remember", "agent.history"],
		note: "Its mental map and its own past turns",
	},
	{
		id: "A-10",
		title: "Publish an interactive app for the operator",
		actors: ["AG"],
		operations: [
			"file.write",
			"app.declare",
			"app.run",
			"app.status",
			"message.send",
			"app.control",
		],
		note: "Planned. The agent writes the app, declares it, sees it answer, and tells the operator where to find it",
	},
]);

export type JourneyId = (typeof JOURNEYS)[number]["id"];
