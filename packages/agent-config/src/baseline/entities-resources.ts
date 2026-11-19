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
	alert,
] as const;
