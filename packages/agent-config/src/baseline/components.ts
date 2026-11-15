import type { Component, DependencyRule } from "./types.js";

const CP = "packages/control-plane/src";
const MM = "packages/agent-runtime-worker/src";

export const COMPONENT_IDS = [
	"cp-api",
	"cp-mission-ops",
	"cp-machines",
	"cp-scheduler",
	"cp-oversight",
	"cp-copilot",
	"cp-mc-gateway",
	"cp-edge",
	"cp-host",
	"mm-daemon",
	"mm-agent-loop",
	"mm-tools",
	"mm-mission-copilot",
	"mm-monitor",
	"mm-jobs",
	"mm-state",
	"mm-isolation",
	"mm-cli",
	"config",
	"cockpit",
	"skills",
] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

/** The components MAGI is built from; each operation's home lies in exactly one. */
export const COMPONENTS: readonly Component<ComponentId>[] = [
	// ── Control plane ───────────────────────────────────────────────────────
	{
		id: "cp-api",
		plane: "control-plane",
		name: "Mission API",
		responsibility:
			"The operator's routes: missions, drafts, config, limits, reads",
		root: CP,
		paths: [
			"mission-routes-*",
			"missions.ts",
			"mission-drafts.ts",
			"mission-scope.ts",
			"mission-status.ts",
			"mission-resource-routes.ts",
			"catalog-routes.ts",
			"platform-routes.ts",
			"public-routes.ts",
			"templates.ts",
			"config-version.ts",
			"async-handler.ts",
		],
	},
	{
		id: "cp-mission-ops",
		plane: "control-plane",
		name: "Mission operations",
		responsibility:
			"The homes of mission operations: lifecycle, launch claims, limits, spend",
		root: CP,
		paths: [
			"mission-lifecycle-actions.ts",
			"mission-claims.ts",
			"mission-limits.ts",
			"mission-spend.ts",
			"spend-policy.ts",
			"mission-stats-summary.ts",
		],
	},
	{
		id: "cp-machines",
		plane: "control-plane",
		name: "Machine lifecycle",
		responsibility:
			"Fly machines and volumes: provision, wake, resize, upgrade, segments",
		root: CP,
		paths: ["machine-*", "fly-*", "resource-upgrade*"],
	},
	{
		id: "cp-scheduler",
		plane: "control-plane",
		name: "Scheduler",
		responsibility: "Delivering due schedules",
		root: CP,
		paths: ["scheduler.ts"],
	},
	{
		id: "cp-oversight",
		plane: "control-plane",
		name: "Resource oversight",
		responsibility: "Sampling, alerts, the daily report, platform relays",
		root: CP,
		paths: [
			"resource-monitor.ts",
			"resource-alerts.ts",
			"resource-queries.ts",
			"resource-report*",
			"atlas-usage.ts",
			"usage-queries.ts",
			"platform-relay.ts",
			"mailbox-writer.ts",
		],
	},
	{
		id: "cp-copilot",
		plane: "control-plane",
		name: "Control copilot",
		responsibility:
			"Its loop, tools, proposals and their execution, visibility",
		root: CP,
		paths: [
			"copilot-*",
			"pending-actions.ts",
			"transcript-queries.ts",
			"github*.ts",
		],
	},
	{
		id: "cp-mc-gateway",
		plane: "control-plane",
		name: "Mission-copilot gateway",
		responsibility: "What a mission copilot may ask the control plane for",
		root: CP,
		paths: ["mission-copilot-router.ts"],
	},
	{
		id: "cp-edge",
		plane: "control-plane",
		name: "Edge and identity",
		responsibility:
			"Sign-in, sessions, users, security headers, the proxy to mission machines, monitor tokens",
		root: CP,
		paths: [
			"auth*.ts",
			"session-routes.ts",
			"firebase.ts",
			"users.ts",
			"security-headers.ts",
			"proxy.ts",
			"monitor-token.ts",
		],
	},
	{
		id: "cp-host",
		plane: "control-plane",
		name: "Process host",
		responsibility: "Start-up, database, process guards",
		root: CP,
		paths: ["index.ts", "mongo.ts", "process-guards.ts", "types.d.ts"],
	},
	// ── Mission machine ─────────────────────────────────────────────────────
	{
		id: "mm-daemon",
		plane: "mission-machine",
		name: "Daemon",
		responsibility: "Boot, orchestration, dispatch",
		root: MM,
		paths: [
			"daemon.ts",
			"daemon-boot/",
			"orchestrator*",
			"exit-on-fatal.ts",
			"node-polyfill.ts",
		],
	},
	{
		id: "mm-agent-loop",
		plane: "mission-machine",
		name: "Agent loop",
		responsibility:
			"A turn: prompt, LLM calls, tools, limits, reflection, logging",
		root: MM,
		paths: [
			"agent-runner*",
			"loop*.ts",
			"prompt.ts",
			"prompts.ts",
			"reflection.ts",
			"context-utils.ts",
			"limits.ts",
			"llm-*",
			"models.ts",
			"openrouter-pricing.ts",
			"retry-backoff.ts",
			"agent-stats.ts",
			"usage.ts",
			"mental-map.ts",
			"skills.ts",
		],
	},
	{
		id: "mm-tools",
		plane: "mission-machine",
		name: "Agent tools",
		responsibility: "The tools agents call and their isolated execution",
		root: MM,
		paths: [
			"tools/",
			"tools.ts",
			"tool-catalog.ts",
			"tool-args.ts",
			"tool-executor.ts",
			"images/",
			"document-*",
			"pdf-*",
			"ocr-cap.ts",
			"mime-types.ts",
			"artifacts.ts",
		],
	},
	{
		id: "mm-mission-copilot",
		plane: "mission-machine",
		name: "Mission copilot",
		responsibility: "Its tools and their checks",
		root: MM,
		paths: ["mission-copilot*", "resource-upgrade-tool.ts"],
	},
	{
		id: "mm-monitor",
		plane: "mission-machine",
		name: "Monitor server",
		responsibility:
			"The cockpit-facing routes on the mission machine (port 4000)",
		root: MM,
		paths: ["monitor-*", "monitor-routes/"],
	},
	{
		id: "mm-jobs",
		plane: "mission-machine",
		name: "Jobs and schedules",
		responsibility:
			"Background jobs, the Tool API (port 4001), schedule ingestion",
		root: MM,
		paths: ["job-*", "tool-api-server.ts", "schedule-ingest.ts"],
	},
	{
		id: "mm-state",
		plane: "mission-machine",
		name: "Mission state",
		responsibility:
			"Mailbox, conversations, config, objectives, stats, anomalies, resources",
		root: MM,
		paths: [
			"mailbox.ts",
			"conversation-repository.ts",
			"mission-config*",
			"objectives/",
			"anomaly*",
			"resource-alert-state.ts",
			"resource-sampler.ts",
			"resource-thresholds.ts",
			"mongo.ts",
		],
	},
	{
		id: "mm-isolation",
		plane: "mission-machine",
		name: "Isolation and safety",
		responsibility: "OS users, workspaces, git, safe paths and HTTP",
		root: MM,
		paths: [
			"linux-user.ts",
			"workspace-*",
			"safe-*",
			"ssrf.ts",
			"remove-if-exists.ts",
		],
	},
	{
		id: "mm-cli",
		plane: "mission-machine",
		name: "Developer CLI",
		responsibility: "Local commands",
		root: MM,
		paths: ["cli*.ts", "user-input.ts", "index.ts"],
	},
	// ── Shared and front end ────────────────────────────────────────────────
	{
		id: "config",
		plane: "shared",
		name: "Configuration and stored types",
		responsibility:
			"Team-config schema, stored document types, collections, model defaults, the env catalogue, the baselines",
		root: "packages/agent-config/src",
		paths: ["**"],
	},
	{
		id: "cockpit",
		plane: "shared",
		name: "Cockpit",
		responsibility: "The operator's UI",
		root: "packages/cockpit/src",
		paths: ["**"],
	},
	{
		id: "skills",
		plane: "shared",
		name: "Platform skills",
		responsibility: "Skills shipped to every mission",
		root: "packages/skills",
		paths: ["**"],
	},
];

/** Prose until dependency-cruiser enforces them. */
export const DEPENDENCY_RULES: readonly DependencyRule[] = [
	{
		id: "dep.cockpit",
		text: "The cockpit depends only on `config` types and on the control plane's HTTP API.",
	},
	{
		id: "dep.through-home",
		text: "Entry points (`cp-api`, `cp-copilot`, `cp-mc-gateway`, `mm-monitor`, `mm-mission-copilot`) reach mission state changes through their operation's home, never by writing the collection directly.",
	},
];

/** `*` matches any run of characters except `/`; everything else is literal. */
function globMatches(glob: string, text: string): boolean {
	const [first, ...rest] = glob.split("*");
	if (!text.startsWith(first)) return false;
	if (rest.length === 0) return text === first;
	let pos = first.length;
	for (let k = 0; k < rest.length; k++) {
		const part = rest[k];
		const last = k === rest.length - 1;
		const at = last ? text.length - part.length : text.indexOf(part, pos);
		if (at < pos || !text.endsWith(part, at + part.length)) return false;
		if (text.slice(pos, at).includes("/")) return false;
		pos = at + part.length;
	}
	return pos === text.length;
}

/** Does `pattern` (see `Component.paths`) own `rel`, a path relative to the component's root? */
export function patternOwns(pattern: string, rel: string): boolean {
	if (pattern === "**") return true;
	if (pattern.endsWith("/")) return rel.startsWith(pattern);
	return globMatches(pattern, rel);
}

/** Every component owning `repoPath` (a path from the repository root); exactly one when the baseline is sound. */
export function componentsOwning(repoPath: string): ComponentId[] {
	const owners = new Set<ComponentId>();
	for (const c of COMPONENTS) {
		const prefix = `${c.root}/`;
		if (!repoPath.startsWith(prefix)) continue;
		const rel = repoPath.slice(prefix.length);
		if (c.paths.some((p) => patternOwns(p, rel))) owners.add(c.id);
	}
	return [...owners];
}
