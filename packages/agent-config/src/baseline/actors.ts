import type { Actor } from "./types.js";

export const ACTOR_IDS = ["OP", "CC", "MC", "AG", "SUB", "JOB", "PLT"] as const;
export type ActorId = (typeof ACTOR_IDS)[number];

/**
 * Who can ask MAGI for something: whoever reaches an entry point directly and
 * decides for itself what to ask (D3). Asking through someone else does not
 * make an actor (D4), and wider authority over the same entry points is a
 * rule, not an actor (D5).
 */
export const ACTORS: readonly Actor<ActorId>[] = [
	{
		id: "OP",
		name: "Operator: a signed-in user, owner of their missions",
		authority:
			'Everything on their own missions, within the platform\'s ceilings; confirms what a copilot proposes. A platform admin (`CONTROL_API_KEY`, or a user in `PLATFORM_ADMIN_USER_IDS`) is an operator with wider authority, written as rules ("ADM: …"): any mission, ceilings above the platform maximum, platform alerts',
		reachesThrough:
			"Cockpit → control-plane routes under `/api` (session or admin key); the mission's cockpit pages through the proxy to the mission machine",
	},
	{
		id: "CC",
		name: "Control copilot: the operator's assistant in the cockpit, an agent with privileged access that runs on the control plane",
		authority:
			"Reads the operator's missions; any change is a proposal the operator confirms; receives the platform's reports and alerts",
		reachesThrough:
			"Copilot tools (reads) and copilot actions (proposals, executed on confirmation); a shell in its own folder",
	},
	{
		id: "MC",
		name: "Mission copilot: an agent with privileged access that supervises one mission from inside it",
		authority:
			"Configuration, objectives, schedules and spend cap of its own mission, within the ceiling; reports each change to the operator; receives the reports and alerts about its mission",
		reachesThrough:
			"Mission-copilot tools on the mission machine, on top of every agent tool; the control plane's mission-copilot routes",
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
		id: "SUB",
		name: "Sub-agent: a model loop an agent's tool starts (the Research loop, CreateImage's image agent)",
		authority:
			"Acts with the calling agent's identity and budget, through a narrower set of tools; the agent sees only its answer",
		reachesThrough:
			"The tools its loop is given: Research's SearchWeb, FetchUrl, BrowseWeb and Bash; the image agent's own tools",
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
	"Copilots are agents with privileged access: what they share with every agent is the agent's operation, and what they may do beyond it is a rule. A sub-agent is an actor of its own because it decides for itself, reads untrusted content far more than its agent, and the catalog must say which operations it may reach.";
