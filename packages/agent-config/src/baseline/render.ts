/**
 * Renders the baseline documents from the catalog. `baseline.unit.test.ts`
 * fails when a rendered document differs from the file on disk; regenerate
 * with `npm run docs:baseline`.
 */

import { ACTORS, ACTORS_NOTE } from "./actors.js";
import { COMPONENTS, DEPENDENCY_RULES } from "./components.js";
import { ENTITIES } from "./entities.js";
import { ENTRY_CLASSES } from "./entry-classes.js";
import { JOURNEYS } from "./journeys.js";
import { OPERATIONS } from "./operations.js";
import { PLATFORM_INVARIANTS } from "./platform-invariants.js";
import { DATA_STORES, EXTERNAL_SYSTEMS } from "./stores.js";
import type {
	BaselineStatus,
	Enforcement,
	Invariant,
	OperationGroup,
	Plane,
} from "./types.js";

export const BASELINE_STATUS: { status: BaselineStatus; since: string } = {
	status: "draft",
	since: "2026-11-14",
};

function cell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function table(head: string[], rows: string[][]): string {
	return [
		`| ${head.join(" | ")} |`,
		`|${head.map(() => "---").join("|")}|`,
		...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
	].join("\n");
}

const code = (s: string) => `\`${s}\``;
const list = (xs: readonly string[]) => xs.join(", ");

function header(title: string, intro: string): string {
	const status =
		BASELINE_STATUS.status === "draft"
			? `**Draft since ${BASELINE_STATUS.since}, awaiting the product owner's approval.**`
			: `**Approved ${BASELINE_STATUS.since}.**`;
	return [
		"<!-- Generated from packages/agent-config/src/baseline/ by `npm run docs:baseline`. Edit the catalog, not this file. -->",
		"",
		`# ${title}`,
		"",
		`${status} ${intro}`,
		"",
	].join("\n");
}

function enforcement(e: Enforcement): string {
	switch (e.kind) {
		case "test":
			return "a test";
		case "scan":
			return `scan ${code(e.query)}`;
		case "runtime":
			return `runtime check in ${e.where}`;
		case "review":
			return "review";
	}
}

function invariantLine(i: Invariant): string {
	const facts = [
		i.enforcedBy.length > 0
			? `enforced by ${i.enforcedBy.map(enforcement).join(", ")}`
			: "not yet enforced",
		...(i.decidedBy ? [`decided in ${i.decidedBy}`] : []),
		...(i.open ? [`**open decision:** ${i.open}`] : []),
	];
	return `- ${code(i.id)}: ${i.text} *(${facts.join("; ")})*`;
}

function renderActors(): string {
	return [
		header(
			"Actors",
			"Who can ask MAGI for something. The last column is how the code is reached; scans use it to say which actor an entry point serves. Other baselines: [README](README.md).",
		),
		table(
			["Id", "Actor", "Authority", "Reaches MAGI through"],
			ACTORS.map((a) => [code(a.id), a.name, a.authority, a.reachesThrough]),
		),
		"",
		ACTORS_NOTE,
		"",
	].join("\n");
}

function renderEntities(): string {
	const parts = [
		header(
			"Entities and their states",
			'What actors work with, each one\'s states, and the transitions the product intends. "Stored as" is the join with the code. A status write the code makes that is not a transition below is a finding, and so is a transition below that no code makes.',
		),
	];
	for (const e of ENTITIES) {
		const store =
			e.store.kind === "collection"
				? `Stored as ${code(e.store.collection)} (${code(e.store.type)}${e.store.statusField ? `, field ${code(e.store.statusField)}` : ""}).`
				: `Stored in: ${e.store.where}.`;
		parts.push(`## ${e.name} (${code(e.id)})`, "", store);
		if (e.notes) parts.push("", e.notes);
		parts.push(
			"",
			table(
				["State", "Meaning"],
				e.states.map((s) => [
					code(s.id) + (s.planned ? " (planned)" : ""),
					s.meaning,
				]),
			),
			"",
		);
		if (e.transitions.length > 0) {
			parts.push(
				table(
					["From", "Event", "To", "Who", "Note"],
					e.transitions.map((t) => [
						t.from === null ? "—" : code(t.from),
						t.event,
						code(t.to),
						list(t.actors),
						t.note ?? "",
					]),
				),
				"",
			);
		}
		if (e.invariants.length > 0) {
			parts.push("Invariants:", ...e.invariants.map(invariantLine), "");
		}
	}
	parts.push(
		"## Platform-wide invariants",
		"",
		"What holds across entities: the record of what happened, and what survives a restart.",
		"",
		...PLATFORM_INVARIANTS.map(invariantLine),
		"",
	);
	return parts.join("\n");
}

const GROUP_TITLES: Record<OperationGroup, string> = {
	missions: "Missions",
	spend: "Spend and machine",
	agents: "Agents and the agent loop",
	messages: "Messages",
	files: "Files",
	schedules: "Schedules",
	jobs: "Background jobs",
	objectives: "Objectives",
	images: "Images",
	copilot: "Copilot",
	platform: "Platform and account",
};

const READ_RULE =
	"The same figure wherever it is shown; reading never changes it";

function renderOperations(): string {
	const parts = [
		header(
			"Operations",
			'What actors can ask MAGI to do. An operation is defined by its intent; its rules hold whoever asks. **One operation per intent whose rules differ** (who may ask, what is checked, what it costs, what it changes): requests with the same rules are one operation whatever their entry point, and different rules make different operations even on the same data. Each operation has **one** implementation in the code (its home), in the component named here, and every entry point that serves it calls that home, adding only who may ask and how the result is shown ([code-structure practice](../practices/code-structure.md), "One operation, one home"). Every entry point declares the operation id it serves, or an entry class (end of this page). "(read)" marks a figure shown to its actors. Actors: [actors.md](actors.md); "CC" means a proposal the operator confirms.',
		),
	];
	for (const group of Object.keys(GROUP_TITLES) as OperationGroup[]) {
		const ops = OPERATIONS.filter((o) => o.group === group);
		parts.push(
			`## ${GROUP_TITLES[group]}`,
			"",
			table(
				["Id", "Intent", "Actors", "Home", "Rules that hold for every actor"],
				ops.map((o) => [
					code(o.id) +
						(o.read ? " (read)" : "") +
						(o.planned ? " (planned)" : ""),
					o.intent,
					list(o.actors),
					code(o.home),
					[...(o.read ? [READ_RULE] : []), ...o.rules].join("; "),
				]),
			),
			"",
		);
	}
	parts.push(
		"## Entry classes",
		"",
		"Entry points that serve no product operation declare one of these classes instead. Adding a class is a baseline change, approved like an operation.",
		"",
		table(
			["Class", "What", "Why no operation"],
			ENTRY_CLASSES.map((c) => [code(c.id), c.what, c.why]),
		),
		"",
	);
	return parts.join("\n");
}

function renderJourneys(): string {
	return [
		header(
			"Operator journeys",
			"The journeys MAGI must support, the actors expected to complete each one, and the operations they use. A journey is verified by walking it for every expected actor: each step reachable, each hand-off reported back, the same result whoever asks. Each journey should have an end-to-end test or scenario that names its id.",
		),
		table(
			["Id", "Journey", "Actors", "Operations", "Note"],
			JOURNEYS.map((j) => [
				j.id,
				j.title,
				list(j.actors),
				j.operations.map(code).join(", "),
				j.note ?? "",
			]),
		),
		"",
	].join("\n");
}

const PLANE_TITLES: Record<Plane, string> = {
	"control-plane": "Control plane",
	"mission-machine": "Mission machine",
	browser: "Cockpit (in the browser)",
	shared: "Shared",
};

function renderComponents(): string {
	const parts = [
		header(
			"Components",
			"The architecture baseline: the components MAGI is built from, each with its responsibility and the source paths it owns. The product baseline ([../product/](../product/README.md)) says what MAGI does; this says how it is built. Each operation's home lies in exactly one component. Every source file under a root belongs to exactly one component (tests excluded): `dir/` owns a directory, `**` the whole root, anything else is a glob on the path under the root.",
		),
	];
	for (const plane of Object.keys(PLANE_TITLES) as Plane[]) {
		const comps = COMPONENTS.filter((c) => c.plane === plane);
		parts.push(
			`## ${PLANE_TITLES[plane]}`,
			"",
			table(
				["Id", "Component", "Responsibility", "Root", "Paths"],
				comps.map((c) => [
					code(c.id),
					c.name,
					c.responsibility,
					code(c.root),
					c.paths.map(code).join(", "),
				]),
			),
			"",
		);
	}
	parts.push(
		"## Data stores",
		"",
		"Each MongoDB collection, what it holds and the one component whose code writes it. A write from any other component is a finding unless it is listed as an exception. The owner is the component, not the process.",
		"",
		table(
			["Collection", "Holds", "Owner", "Also written by"],
			DATA_STORES.map((d) => [
				code(d.collection),
				d.holds,
				code(d.owner),
				(d.alsoWrittenBy ?? [])
					.map((x) => `${code(x.component)} (${x.what})`)
					.join("; "),
			]),
		),
		"",
		"## External systems",
		"",
		table(
			["Id", "System", "Used for", "Reached by"],
			EXTERNAL_SYSTEMS.map((x) => [
				code(x.id),
				x.name,
				x.usedFor,
				x.reachedBy.map(code).join(", "),
			]),
		),
		"",
		"## Dependency rules",
		"",
		"Prose until dependency-cruiser enforces them.",
		"",
		...DEPENDENCY_RULES.map((r) => `- ${code(r.id)}: ${r.text}`),
		"",
	);
	return parts.join("\n");
}

/** Every rendered document, keyed by its path from the repository root. */
export function renderBaselineDocs(): Record<string, string> {
	return {
		"docs/product/actors.md": renderActors(),
		"docs/product/entities.md": renderEntities(),
		"docs/product/operations.md": renderOperations(),
		"docs/product/journeys.md": renderJourneys(),
		"docs/architecture/components.md": renderComponents(),
	};
}
