import { defineEntity } from "./define-entity.js";

/** A mission's machine, files and memories, its alerts, and the templates missions start from. */
const template = defineEntity({
	id: "template",
	name: "Template (planned: editable templates, on the roadmap)",
	store: {
		kind: "other",
		where:
			"Today: read-only files in `config/teams/` (ADR-0021). Planned: a database collection, with the preset templates loaded into it at install",
	},
	states: [],
	transitions: [],
	invariants: [
		{
			id: "template.decoupled",
			text: "Once launched, a mission is independent of its template: a change to either never reaches the other.",
			enforcedBy: [],
		},
	],
	notes:
		"Everything needed to start a mission: its parameters, the roster, the objective tree, and each agent's prompt, tasks, initial mental map, tools and skills. Every template is visible to every operator.",
});

const machine = defineEntity({
	id: "machine",
	name: "Mission machine",
	store: {
		kind: "collection",
		collection: "machineSegments",
		type: "MachineSegment",
	},
	states: [
		{ id: "default", meaning: "Running on the mission's own size" },
		{ id: "upgraded", meaning: "Running bigger for a while" },
	],
	transitions: [
		{ from: "default", event: "upgrade", to: "upgraded", actors: ["MC"] },
		{
			from: "upgraded",
			event: "revert on time",
			to: "default",
			actors: ["PLT"],
		},
	],
	invariants: [
		{
			id: "machine.upgrade-bounded",
			text: "An upgrade reverts on time, and a mission's upgrades stay within the daily allowance until the operator resets it.",
			enforcedBy: [],
			decidedBy: "ADR-0031",
		},
	],
	notes:
		"One stored segment per stretch the machine ran with one size; the runtime by size and the allowance are computed from them.",
});

const mentalMap = defineEntity({
	id: "mental-map",
	name: "Mental map",
	store: {
		kind: "other",
		where: "Saved with the agent's conversation (`conversationMessages`)",
	},
	states: [],
	transitions: [],
	invariants: [
		{
			id: "mental-map.platform-regions",
			text: "The regions the platform manages are written by the platform only; the agent edits its own sections.",
			enforcedBy: [],
		},
		{
			id: "mental-map.edit-between-turns",
			text: "An operator's or a copilot's edit to an agent's mental map never lands during that agent's turn.",
			enforcedBy: [],
		},
	],
	notes: "An agent's working memory, in its prompt every turn.",
});

const missionFile = defineEntity({
	id: "file",
	name: "Mission file",
	store: {
		kind: "other",
		where:
			"The mission's volume: the shared folder and each agent's workdir, with the history of each file",
	},
	states: [],
	transitions: [],
	invariants: [],
	notes:
		"Who changed a file and when is the platform invariant `files.attributed`.",
});

const app = defineEntity({
	id: "app",
	name: "Interactive app",
	store: {
		kind: "collection",
		collection: "missionApps",
		type: "MissionAppDoc",
		statusField: "status",
	},
	states: [
		{
			id: "starting",
			meaning:
				"Declared or started; the platform is launching it and waiting for it to answer",
		},
		{ id: "running", meaning: "Answering on its port" },
		{
			id: "stopped",
			meaning:
				"Stopped on request, when the mission was suspended or the daemon restarted, or after the idle time unopened; still declared",
		},
		{
			id: "failed",
			meaning:
				"Exited, or stopped answering, more often than the restart limit allows",
		},
	],
	transitions: [
		{
			from: null,
			event: "declare",
			to: "stopped",
			actors: ["AG"],
			note: "Started at once (stopped → starting) unless the limit on apps running or the firewall prevents it",
		},
		{
			from: "starting",
			event: "answers on its port",
			to: "running",
			actors: ["PLT"],
		},
		{
			from: "starting",
			event: "exits or never answers, past the restart limit",
			to: "failed",
			actors: ["PLT"],
			note: "Its owner is told",
		},
		{
			from: "starting",
			event: "stop, mission suspended, or daemon restarted before it answers",
			to: "stopped",
			actors: ["OP", "MC", "AG", "PLT"],
			note: "AG: its own apps",
		},
		{
			from: "running",
			event: "exits or stops answering, within the restart limit",
			to: "starting",
			actors: ["PLT"],
			note: "Restarted at once; the restart is counted",
		},
		{
			from: "running",
			event: "exits or stops answering, past the restart limit",
			to: "failed",
			actors: ["PLT"],
			note: "Its owner is told",
		},
		{
			from: "running",
			event: "stop",
			to: "stopped",
			actors: ["OP", "MC", "AG"],
			note: "AG: its own apps; its owner is told when someone else stops it",
		},
		{
			from: "running",
			event:
				"mission suspended, daemon restarted, or unopened past the idle time",
			to: "stopped",
			actors: ["PLT"],
		},
		{
			from: "stopped",
			event: "start, or the operator opens it",
			to: "starting",
			actors: ["OP", "MC", "AG"],
			note: "AG: its own apps",
		},
		{
			from: "failed",
			event: "start, or the operator opens it",
			to: "starting",
			actors: ["OP", "MC", "AG"],
			note: "AG: its own apps",
		},
	],
	invariants: [
		{
			id: "app.loopback-only",
			text: "An app is reachable only through the apps host: it never listens on an address another machine can reach.",
			enforcedBy: [
				{
					kind: "runtime",
					where:
						"agent-runtime-worker/src/app-commands.ts: appLaunch (every kind bound to 127.0.0.1); machine-firewall.ts: initMachineFirewall (inbound dropped but for 22 and 4000, loopback app ports only for the daemon and the owner)",
				},
				{ kind: "test" },
			],
		},
		{
			id: "app.as-owner",
			text: "An app runs as its owner's OS user, with no secrets.",
			enforcedBy: [
				{
					kind: "runtime",
					where:
						"agent-runtime-worker/src/app-processes.ts: appProcesses (sudo -u the owner through magi-app, whose rule keeps only the app variables)",
				},
				{ kind: "test" },
			],
		},
		{
			id: "app.bounded",
			text: "No app runs while its mission is suspended or after the idle time unopened; no more than the limit run at once; a failing app is not restarted without limit.",
			enforcedBy: [
				{
					kind: "runtime",
					where:
						"agent-runtime-worker/src/app-supervisor.ts: createAppSupervisor (the limit, the idle stop, three restarts an hour); app-store.ts: markAllStopped (nothing survives a restart)",
				},
				{ kind: "test" },
			],
		},
	],
	notes:
		"A long-running program an agent serves on the mission machine for the operator to use in a browser: a notebook, a Gradio app, a static site. Declared by a request file the agent writes (`shared/apps/requests/`), like a job. Withdrawing the declaration stops the app and removes it.",
});

const alert = defineEntity({
	id: "alert",
	name: "Resource alert",
	store: {
		kind: "collection",
		collection: "resourceAlertState",
		type: "AlertState",
	},
	states: [
		{ id: "raised", meaning: "The condition holds; its recipients were told" },
		{ id: "cleared", meaning: "The condition no longer holds" },
	],
	transitions: [
		{ from: null, event: "condition met", to: "raised", actors: ["PLT"] },
		{ from: "raised", event: "condition gone", to: "cleared", actors: ["PLT"] },
		{
			from: "cleared",
			event: "condition met again",
			to: "raised",
			actors: ["PLT"],
		},
	],
	invariants: [
		{
			id: "alert.once-per-episode",
			text: "An alert is raised once per episode, not on every sample, and the daily report is sent once per user per day, even across restarts.",
			enforcedBy: [],
			decidedBy: "ADR-0032",
		},
	],
	notes:
		"One per mission (or the platform) and category. The control copilot receives the platform's alerts and reports; the mission copilot those about its mission.",
});

export const RESOURCE_ENTITIES = [
	template,
	machine,
	mentalMap,
	missionFile,
	app,
	alert,
] as const;
