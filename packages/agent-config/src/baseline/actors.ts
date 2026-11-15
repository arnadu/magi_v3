import type { Actor } from "./types.js";

export const ACTOR_IDS = ["OP", "ADM", "CC", "MC", "AG", "JOB", "PLT"] as const;
export type ActorId = (typeof ACTOR_IDS)[number];

/** Who can ask MAGI for something. */
export const ACTORS: readonly Actor<ActorId>[] = [
	{
		id: "OP",
		name: "Operator: a signed-in user, owner of their missions",
		authority:
			"Everything on their own missions, within the platform's ceilings; confirms what a copilot proposes",
		reachesThrough:
			"Cockpit → control-plane routes under `/api` (session); the mission's cockpit pages through the proxy to the mission machine",
	},
	{
		id: "ADM",
		name: "Platform admin: `CONTROL_API_KEY`, or a user listed in `PLATFORM_ADMIN_USER_IDS`",
		authority:
			"As `OP` on any mission; spend ceilings above the platform maximum; platform alerts",
		reachesThrough: "Same routes, with the admin key or an admin session",
	},
	{
		id: "CC",
		name: "Control copilot: the operator's assistant in the cockpit",
		authority:
			"Reads the operator's missions; any change is a proposal the operator confirms",
		reachesThrough:
			"Copilot tools (reads) and copilot actions (proposals, executed on confirmation)",
	},
	{
		id: "MC",
		name: "Mission copilot: supervises one mission from inside it",
		authority:
			"Configuration, objectives, schedules and spend cap of its own mission, within the ceiling; reports each change to the operator",
		reachesThrough:
			"Mission-copilot tools on the mission machine; the control plane's mission-copilot routes",
	},
	{
		id: "AG",
		name: "Agent: a team member of a mission",
		authority:
			"Its own work: files, messages, tasks, schedules and jobs it authors",
		reachesThrough:
			"Agent tools; files it writes in `shared/` (schedules, jobs)",
	},
	{
		id: "JOB",
		name: "Background job: a script an agent submitted, running as that agent",
		authority: "What its author could do, through scoped tools",
		reachesThrough: "The Tool API on the mission machine",
	},
	{
		id: "PLT",
		name: "The platform itself, on a timer or an event",
		authority:
			"Deliver what is due, sample resources, raise alerts, recover after a restart",
		reachesThrough: "Timers and ticks in the control plane and the daemon",
	},
];

/** Read with the actors table. */
export const ACTORS_NOTE =
	"Not actors: the image sub-agent and the Research sub-agent run inside an agent's tool call, on that agent's behalf and within its budget.";
