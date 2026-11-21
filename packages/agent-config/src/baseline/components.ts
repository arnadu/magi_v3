import type { Component, DependencyRule } from "./types.js";

const CP = "packages/control-plane/src";
const MM = "packages/agent-runtime-worker/src";
const UI = "packages/cockpit/src";

export const COMPONENT_IDS = [
	"cp-api",
	"cp-mission-ops",
	"cp-machines",
	"cp-scheduler",
	"cp-oversight",
	"cp-records",
	"cp-copilot",
	"cp-mc-gateway",
	"cp-apps",
	"cp-edge",
	"cp-host",
	"mm-daemon",
	"mm-agent-loop",
	"mm-tools",
	"mm-mission-copilot",
	"mm-monitor",
	"mm-jobs",
	"mm-apps",
	"mm-state",
	"mm-isolation",
	"mm-cli",
	"ui-shell",
	"ui-api",
	"ui-missions",
	"ui-config",
	"ui-activity",
	"ui-files",
	"ui-objectives",
	"ui-limits",
	"ui-copilot",
	"ui-apps",
	"ui-kit",
	"config",
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
		layer: 3,
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
		layer: 2,
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
		layer: 1,
		root: CP,
		paths: ["machine-*", "fly-*", "resource-upgrade*"],
	},
	{
		id: "cp-scheduler",
		plane: "control-plane",
		name: "Scheduler",
		responsibility: "Delivering due schedules",
		layer: 2,
		root: CP,
		paths: ["scheduler.ts"],
	},
	{
		id: "cp-oversight",
		plane: "control-plane",
		name: "Resource oversight",
		responsibility: "Sampling, alerts, the daily report, platform relays",
		layer: 1,
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
		id: "cp-records",
		plane: "control-plane",
		name: "Mission records",
		responsibility:
			"Reads of what agents and copilots did (turns, transcripts, model calls), served from the database so they work while a mission's machine is stopped",
		layer: 1,
		root: CP,
		paths: ["transcript-queries.ts"],
	},
	{
		id: "cp-copilot",
		plane: "control-plane",
		name: "Control copilot",
		responsibility:
			"Its loop, tools, proposals and their execution, visibility",
		layer: 4,
		root: CP,
		paths: ["copilot-*", "pending-actions.ts", "github*.ts"],
	},
	{
		id: "cp-mc-gateway",
		plane: "control-plane",
		name: "Mission-copilot gateway",
		responsibility: "What a mission copilot may ask the control plane for",
		layer: 5,
		root: CP,
		paths: ["mission-copilot-router.ts"],
	},
	{
		id: "cp-edge",
		plane: "control-plane",
		name: "Edge and identity",
		responsibility:
			"Sign-in, sessions, users, security headers, the proxy to mission machines, monitor tokens",
		layer: 2,
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
		id: "cp-apps",
		plane: "control-plane",
		name: "Apps host",
		responsibility:
			"The apps host: the ticket from the cockpit, the app sign-in, the proxy to mission machines' apps",
		layer: 2,
		root: CP,
		paths: ["apps-host/"],
	},
	{
		id: "cp-host",
		plane: "control-plane",
		name: "Process host",
		responsibility: "Start-up, database, process guards",
		layer: 6,
		root: CP,
		paths: ["index.ts", "mongo.ts", "process-guards.ts", "types.d.ts"],
	},
	// ── Mission machine ─────────────────────────────────────────────────────
	{
		id: "mm-daemon",
		plane: "mission-machine",
		name: "Daemon",
		responsibility: "Boot, orchestration, dispatch",
		layer: 5,
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
		layer: 3,
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
			"mental-map*",
			"skills.ts",
		],
	},
	{
		id: "mm-tools",
		plane: "mission-machine",
		name: "Agent tools",
		responsibility: "The tools agents call and their isolated execution",
		layer: 2,
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
		layer: 4,
		root: MM,
		paths: ["mission-copilot*", "resource-upgrade-tool.ts"],
	},
	{
		id: "mm-monitor",
		plane: "mission-machine",
		name: "Monitor server",
		responsibility:
			"The cockpit-facing routes on the mission machine (port 4000)",
		layer: 4,
		root: MM,
		paths: ["monitor-*", "monitor-routes/"],
	},
	{
		id: "mm-jobs",
		plane: "mission-machine",
		name: "Jobs and schedules",
		responsibility:
			"Background jobs, the Tool API (port 4001), schedule ingestion",
		layer: 4,
		root: MM,
		paths: ["job-*", "tool-api-server.ts", "schedule-ingest.ts"],
	},
	{
		id: "mm-apps",
		plane: "mission-machine",
		name: "Interactive apps",
		responsibility:
			"App declarations, starting and watching apps, the hop from the monitor server to each app",
		layer: 4,
		root: MM,
		paths: ["app-*"],
	},
	{
		id: "mm-state",
		plane: "mission-machine",
		name: "Mission state",
		responsibility:
			"Mailbox, conversations, config, objectives, stats, anomalies, resources",
		layer: 1,
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
		name: "Isolation and mission files",
		responsibility:
			"OS users, workspaces, git, safe paths and HTTP; reading and writing the mission's files within their folders",
		layer: 1,
		root: MM,
		paths: [
			"linux-user.ts",
			"workspace-*",
			"safe-*",
			"ssrf.ts",
			"machine-firewall.ts",
			"remove-if-exists.ts",
		],
	},
	{
		id: "mm-cli",
		plane: "mission-machine",
		name: "Developer CLI",
		responsibility: "Local commands",
		layer: 6,
		root: MM,
		paths: ["cli*.ts", "user-input.ts", "index.ts"],
	},
	// ── Cockpit (the operator's UI, in the browser) ─────────────────────────
	{
		id: "ui-shell",
		plane: "browser",
		name: "Cockpit shell",
		responsibility:
			"Sign-in, header, navigation between missions and their tabs, the home view",
		layer: 3,
		root: UI,
		paths: [
			"main.tsx",
			"App.tsx",
			"Header.tsx",
			"TabBar.tsx",
			"HomeView.tsx",
			"LoginScreen.tsx",
			"SignOutButton.tsx",
			"MissionDashboard.tsx",
			"auth.ts",
			"app-hooks.ts",
			"styles.css",
			"vite-env.d.ts",
		],
	},
	{
		id: "ui-api",
		plane: "browser",
		name: "Cockpit API client",
		responsibility:
			"Every call from the cockpit to the control plane, and the polling around them",
		layer: 1,
		root: UI,
		paths: ["api/", "data.ts", "use-api-resource.ts", "use-visible-poll.ts"],
	},
	{
		id: "ui-missions",
		plane: "browser",
		name: "Missions and drafts",
		responsibility:
			"The mission list, templates, creating and editing drafts, launching, suspending and resuming",
		layer: 2,
		root: UI,
		paths: [
			"MissionsPanel.tsx",
			"TemplatesPanel.tsx",
			"Draft*.tsx",
			"use-draft-*",
			"mission-status-action.ts",
		],
	},
	{
		id: "ui-config",
		plane: "browser",
		name: "Mission configuration",
		responsibility:
			"Editing a mission's settings, agents, skills, tools, image settings and mental maps",
		layer: 2,
		root: UI,
		paths: [
			"Config*.tsx",
			"AgentToggles.tsx",
			"MentalMap*.tsx",
			"ImageSettingsFields.tsx",
			"image-settings.ts",
			"mental-map-diff.ts",
			"available-skills.ts",
			"use-catalog.ts",
			"use-mission-config-editor.ts",
		],
	},
	{
		id: "ui-activity",
		plane: "browser",
		name: "Mission activity",
		responsibility:
			"What the agents did: conversations, transcripts, model calls, the trace timeline, the log, agent errors",
		layer: 2,
		root: UI,
		paths: [
			"ConversationsPanel.tsx",
			"conversations/",
			"TranscriptsPanel.tsx",
			"transcripts/",
			"TracePanel.tsx",
			"trace/",
			"LogPanel.tsx",
			"AgentErrorBanner.tsx",
			"call-index.ts",
			"llm-call-types.ts",
		],
	},
	{
		id: "ui-files",
		plane: "browser",
		name: "Mission files",
		responsibility:
			"Browsing, viewing, uploading and editing the mission's files",
		layer: 2,
		root: UI,
		paths: ["FilesPanel.tsx", "use-file-node.ts"],
	},
	{
		id: "ui-objectives",
		plane: "browser",
		name: "Objectives",
		responsibility: "The objective tree, tasks and KPIs, and their progress",
		layer: 2,
		root: UI,
		paths: ["ObjectivesPanel.tsx", "types.ts"],
	},
	{
		id: "ui-limits",
		plane: "browser",
		name: "Spend, limits and schedules",
		responsibility:
			"Spend against cap and ceiling, agent limits, machine runtime and upgrades, schedules",
		layer: 2,
		root: UI,
		paths: [
			"LimitsPanel.tsx",
			"RuntimePanel.tsx",
			"UpgradeLimitsSection.tsx",
			"SchedulePanel.tsx",
			"mission-spend.ts",
		],
	},
	{
		id: "ui-copilot",
		plane: "browser",
		name: "Copilot panel",
		responsibility:
			"Talking to the copilot, confirming its proposals, its transcripts, files, limits and settings",
		layer: 2,
		root: UI,
		paths: ["Copilot*.tsx", "copilot/"],
	},
	{
		id: "ui-apps",
		plane: "browser",
		name: "Apps (planned)",
		responsibility:
			"The Apps tab: a mission's apps, their state, Open, copy the URL, start and stop",
		layer: 2,
		root: UI,
		paths: [],
	},
	{
		id: "ui-kit",
		plane: "browser",
		name: "Cockpit building blocks",
		responsibility:
			"Shared display pieces: Markdown, JSON trees, loading and error states, the resizable message box",
		layer: 1,
		root: UI,
		paths: [
			"Markdown.tsx",
			"markdown.ts",
			"JsonTree.tsx",
			"LoadingView.tsx",
			"load-error.tsx",
			"InputResizeGrip.tsx",
			"use-input-resize.ts",
		],
	},
	// ── Shared ──────────────────────────────────────────────────────────────
	{
		id: "config",
		plane: "shared",
		name: "Configuration and stored types",
		responsibility:
			"Team-config schema, stored document types, collections, model defaults, the env catalogue, the baselines",
		layer: 0,
		root: "packages/agent-config/src",
		paths: ["**"],
	},
	{
		id: "skills",
		plane: "shared",
		name: "Platform skills",
		responsibility: "Skills shipped to every mission",
		layer: 0,
		root: "packages/skills",
		paths: ["**"],
	},
];

/** Prose until dependency-cruiser enforces them. */
export const DEPENDENCY_RULES: readonly DependencyRule[] = [
	{
		id: "dep.cockpit",
		text: "The cockpit's components (`ui-*`) depend only on `config` types and on each other; they reach the platform only over the control plane's HTTP API.",
	},
	{
		id: "dep.ui-api",
		text: "Only `ui-api` calls the control plane; every other cockpit component goes through it.",
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
