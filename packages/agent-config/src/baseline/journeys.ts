import type { ActorId } from "./actors.js";
import type { OperationId } from "./operations.js";
import type { Journey } from "./types.js";

function defineJourneys<const J extends string>(
	journeys: readonly Journey<J, ActorId, OperationId>[],
): readonly Journey<J, ActorId, OperationId>[] {
	return journeys;
}

/**
 * The journeys MAGI must support. A journey is verified by walking it for
 * every expected actor: each step reachable, each hand-off reported back,
 * the same result whoever asks. Tests and scenarios that walk one name its id.
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
		title: "Create a mission from a request",
		actors: ["OP", "CC"],
		operations: [
			"mission.create-draft",
			"mission.edit-draft",
			"mission.launch",
		],
	},
	{
		id: "J-03",
		title: "Customize a draft before launch",
		actors: ["OP", "CC"],
		operations: ["mission.edit-draft", "objectives.edit", "mission.launch"],
	},
	{
		id: "J-04",
		title: "Change a running mission",
		actors: ["OP", "CC", "MC"],
		operations: ["mission.change-config", "mission.suspend", "mission.resume"],
		note: "`mission.change-config` while it runs; suspend and resume only for a change that needs all activity stopped",
	},
	{
		id: "J-05",
		title: "Rename a mission, change its model or cap",
		actors: ["OP", "CC"],
		operations: ["mission.change-config", "mission.set-spend-cap"],
	},
	{
		id: "J-06",
		title: "Schedule recurring work",
		actors: ["OP", "CC", "MC", "AG"],
		operations: ["schedule.create", "schedule.cancel", "mission.wake"],
	},
	{
		id: "J-07",
		title: "Read a mission's results",
		actors: ["OP", "CC", "MC"],
		operations: ["mission.results"],
	},
	{
		id: "J-08",
		title: 'Ask about a mission ("what is X doing?")',
		actors: ["OP", "CC", "MC"],
		operations: ["mission.status", "mission.results"],
	},
	{
		id: "J-09",
		title: "Give the team new work",
		actors: ["OP", "MC"],
		operations: ["message.send", "objectives.edit"],
	},
	{
		id: "J-10",
		title: "Watch and control cost",
		actors: ["OP", "CC", "MC"],
		operations: [
			"mission.spend",
			"mission.set-spend-cap",
			"mission.set-ceiling",
		],
	},
	{
		id: "J-11",
		title: "Handle an alert or anomaly",
		actors: ["OP", "CC", "MC"],
		operations: ["message.send"],
		note: "And the operation the fix needs",
	},
	{
		id: "J-12",
		title: "Recover a mission that won't start or is stuck",
		actors: ["OP", "CC"],
		operations: ["mission.status", "mission.resume"],
	},
	{
		id: "J-13",
		title: "Pause or stop a misbehaving agent",
		actors: ["OP", "MC"],
		operations: ["agent.pause", "agent.resume", "mission.suspend"],
	},
	{
		id: "J-14",
		title: "Give an agent more resources",
		actors: ["AG", "MC", "OP"],
		operations: ["machine.upgrade"],
	},
	{
		id: "J-15",
		title: "Report a bug or idea about MAGI",
		actors: ["OP", "CC", "MC"],
		operations: ["issue.file", "copilot.confirm"],
	},
	{
		id: "J-16",
		title: "Upload a file for the agents, download their work",
		actors: ["OP"],
		operations: ["file.write", "mission.results"],
	},
	{
		id: "J-17",
		title: "Stop a mission for good",
		actors: ["OP", "CC"],
		operations: ["mission.suspend", "mission.archive"],
		note: "`mission.suspend` today; `mission.archive` when built",
	},
]);

export type JourneyId = (typeof JOURNEYS)[number]["id"];
