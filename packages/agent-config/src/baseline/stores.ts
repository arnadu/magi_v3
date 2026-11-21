import type { ComponentId } from "./components.js";
import type { DataStore, ExternalSystem } from "./types.js";

/**
 * Every MongoDB collection, the entity it holds and the one component whose
 * code writes it. A write from any other component is a finding, unless it
 * is listed under `alsoWrittenBy`. The owner is the component, not the
 * process: code of `mm-state` writing from the control plane is still
 * `mm-state` writing.
 */
export const DATA_STORES: readonly DataStore<ComponentId>[] = [
	{
		collection: "missions",
		holds: "mission",
		owner: "cp-mission-ops",
		alsoWrittenBy: [
			{
				component: "cp-machines",
				what: "the machine, volume and machine shape",
			},
		],
	},
	{
		collection: "missionConfigRevisions",
		holds: "Each saved revision of a mission's configuration",
		owner: "cp-mission-ops",
	},
	{ collection: "users", holds: "Signed-in users", owner: "cp-edge" },
	{ collection: "scheduledMessages", holds: "schedule", owner: "cp-scheduler" },
	{ collection: "mailbox", holds: "message", owner: "mm-state" },
	{
		collection: "conversationMessages",
		holds: "turn (its messages, step by step)",
		owner: "mm-state",
	},
	{
		collection: "llmCallLog",
		holds: "llm-call",
		owner: "mm-agent-loop",
		alsoWrittenBy: [{ component: "cp-scheduler", what: "retention pruning" }],
	},
	{
		collection: "agentTurnStats",
		holds: "turn (its statistics)",
		owner: "mm-agent-loop",
	},
	{
		collection: "missionStats",
		holds: "Lifetime totals per agent",
		owner: "mm-agent-loop",
	},
	{
		collection: "missionAnomalies",
		holds: "Anomalies: crashes, timeouts, failed deliveries, resource alerts",
		owner: "mm-state",
		alsoWrittenBy: [
			{
				component: "cp-oversight",
				what: "anomalies the control plane detects",
			},
		],
	},
	{ collection: "objectivesGoals", holds: "objective", owner: "mm-state" },
	{
		collection: "objectivesEvents",
		holds: "task (and KPI, cost and allocation events)",
		owner: "mm-state",
	},
	{
		collection: "missionResources",
		holds: "The latest resource sample of each mission",
		owner: "mm-state",
	},
	{
		collection: "missionApps",
		holds: "app",
		owner: "mm-apps",
		alsoWrittenBy: [
			{
				component: "cp-apps",
				what: "the app's port on the apps host and when it was last opened",
			},
		],
	},
	{
		collection: "platformResources",
		holds: "Platform-wide resource samples (database storage)",
		owner: "cp-oversight",
	},
	{
		collection: "resourceAlertState",
		holds: "Which resource alerts are raised, for de-duplication",
		owner: "mm-state",
	},
	{
		collection: "resourceSnapshots",
		holds: "One daily resource report per user",
		owner: "cp-oversight",
	},
	{
		collection: "machineSegments",
		holds: "Each stretch a mission's machine ran with one shape",
		owner: "cp-machines",
	},
	{
		collection: "copilotPendingActions",
		holds: "pending-action",
		owner: "cp-copilot",
	},
];

/** The services MAGI depends on, outside its own code. */
export const EXTERNAL_SYSTEMS: readonly ExternalSystem<ComponentId>[] = [
	{
		id: "mongodb",
		name: "MongoDB Atlas",
		usedFor: "All persistent state (the data stores above)",
		reachedBy: [
			"cp-mission-ops",
			"cp-machines",
			"cp-scheduler",
			"cp-oversight",
			"cp-records",
			"cp-copilot",
			"cp-edge",
			"cp-api",
			"mm-state",
			"mm-agent-loop",
			"mm-daemon",
			"mm-monitor",
			"mm-mission-copilot",
			"mm-jobs",
		],
	},
	{
		id: "fly",
		name: "Fly.io Machines API",
		usedFor: "Mission machines and volumes",
		reachedBy: ["cp-machines"],
	},
	{
		id: "llm-providers",
		name: "Anthropic and OpenRouter",
		usedFor: "Model calls and image generation",
		reachedBy: ["mm-agent-loop", "mm-tools", "cp-copilot"],
	},
	{
		id: "github",
		name: "GitHub API",
		usedFor: "Issues about MAGI",
		reachedBy: ["cp-copilot"],
	},
	{
		id: "firebase",
		name: "Firebase Authentication",
		usedFor: "Signing operators in",
		reachedBy: ["cp-edge", "ui-shell"],
	},
	{
		id: "web",
		name: "The web (Brave Search and any page an agent opens)",
		usedFor: "Agents' research",
		reachedBy: ["mm-tools"],
	},
	{
		id: "data-providers",
		name: "FRED, FMP and NewsAPI",
		usedFor: "Market and economic data for background jobs",
		reachedBy: ["mm-tools"],
	},
];
