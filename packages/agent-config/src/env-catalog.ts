/**
 * Every environment variable any MAGI process reads, in one place.
 *
 * The code still reads the environment where it needs a value; this list is
 * the contract around those reads. `env-catalog.unit.test.ts` fails when the
 * source reads a variable that is not declared here, when a declared one is
 * no longer read, and when `docs/env.md` (rendered from this list by
 * `renderEnvDoc`) is out of date — so documentation cannot drift from code
 * the way CLAUDE.md's hand-kept list did. Regenerate the doc with
 * `npm run docs:env`.
 */

export type EnvPlane = "control" | "execution" | "cli" | "job";

export interface EnvVar {
	name: string;
	/** Which processes read it. */
	planes: EnvPlane[];
	/** A value used when unset ("—" when unset has its own meaning, explained in `description`). */
	default?: string;
	/** Credential or key: never logged, never forwarded to agent subprocesses. */
	secret?: boolean;
	/** Must be set for the process to start. */
	required?: boolean;
	description: string;
}

export const ENV_CATALOG: readonly EnvVar[] = [
	// ── Shared ──────────────────────────────────────────────────────────────
	{
		name: "MONGODB_URI",
		planes: ["control", "execution", "cli"],
		required: true,
		secret: true,
		description:
			"MongoDB connection string; the database name comes from the URI path. One shared Atlas cluster (M10 since 2026-10-17), one database per environment.",
	},
	{
		name: "ANTHROPIC_API_KEY",
		planes: ["control", "execution", "cli"],
		required: true,
		secret: true,
		description: "Anthropic API key for agents, the copilots and vision calls.",
	},
	{
		name: "OPENROUTER_API_KEY",
		planes: ["control", "execution", "cli"],
		secret: true,
		description: "Enables OpenRouter model ids for `model` / `visionModel`.",
	},
	{
		name: "MODEL",
		planes: ["execution", "cli"],
		default: "claude-sonnet-4-6",
		description: "Default agent model when the mission config names none.",
	},
	{
		name: "VISION_MODEL",
		planes: ["execution", "cli"],
		default: "claude-haiku-4-5-20251001",
		description:
			"Model for FetchUrl image captioning, InspectImage, OCR and BrowseWeb page understanding. Anthropic or OpenRouter id.",
	},
	{
		name: "BRAVE_SEARCH_API_KEY",
		planes: ["execution", "cli"],
		secret: true,
		description:
			"Enables the SearchWeb tool (free tier: 2000 requests/month). Without it the tool is absent.",
	},
	{
		name: "PATH",
		planes: ["execution"],
		description:
			"Passed through, alone with HOME, to agent tool and job subprocesses.",
	},

	// ── Execution plane (mission daemon) ────────────────────────────────────
	{
		name: "MISSION_ID",
		planes: ["execution", "cli"],
		description:
			"Control-plane-provisioned missions: the daemon reads its structured config from MongoDB (ADR-0021). One of MISSION_ID or TEAM_CONFIG is required.",
	},
	{
		name: "TEAM_CONFIG",
		planes: ["execution", "cli"],
		description:
			"Local/dev: path to a team config YAML. One of MISSION_ID or TEAM_CONFIG is required.",
	},
	{
		name: "TEAM_SKILLS_PATH",
		planes: ["execution"],
		default: "<team config dir>/skills",
		description: "Override for the team-tier skills directory.",
	},
	{
		name: "AGENT_WORKDIR",
		planes: ["execution", "cli"],
		default: "cwd",
		description:
			"Root of agent home directories and mission folders (`/missions` on Fly).",
	},
	{
		name: "MONITOR_PORT",
		planes: ["execution"],
		default: "4000",
		description: "MonitorServer port (1–65535).",
	},
	{
		name: "TOOL_PORT",
		planes: ["execution"],
		default: "4001",
		description: "Loopback Tool API server port for background jobs (1–65535).",
	},
	{
		name: "MONITOR_TOKEN",
		planes: ["execution"],
		secret: true,
		description:
			"Per-mission token required on every MonitorServer route, derived from MONITOR_SIGNING_KEY and injected at machine creation. Mandatory when FLY_APP_NAME is set; empty means no auth, for a local developer daemon only.",
	},
	{
		name: "CONTROL_PLANE_URL",
		planes: ["execution"],
		description:
			"Base URL the mission copilot's GitHub-proxy tools call; injected at machine creation. Empty in local dev.",
	},
	{
		name: "MISSION_COPILOT_ENABLED",
		planes: ["execution"],
		default: "true",
		description:
			"`false` opts a mission out of the mission copilot (ADR-0016).",
	},
	{
		name: "MAX_COST_USD",
		planes: ["execution", "cli"],
		description:
			"Fallback spend cap when the mission config sets none (every control-plane mission has one, ADR-0034). The CLI stops the run when it is reached.",
	},
	{
		name: "MAX_AGENT_RUN_SECONDS",
		planes: ["execution", "cli"],
		default: "14400",
		description:
			"Per-dispatch wall-clock timeout; a hung agent run is aborted.",
	},
	{
		name: "REFLECTION_THRESHOLD",
		planes: ["execution", "cli"],
		description:
			"Override, in tokens, for the context size that triggers reflection; default is a fraction of the model's window.",
	},
	{
		name: "MAGI_POOL_SIZE",
		planes: ["execution", "cli"],
		default: "6",
		description:
			"Local dev: size of the magi-wN OS-user pool agents are mapped onto.",
	},
	{
		name: "FLY_APP_NAME",
		planes: ["control", "execution"],
		description:
			'Set by Fly on every machine. Its presence means "running on Fly": the daemon requires MONITOR_TOKEN and enables volume alerts.',
	},
	{
		name: "DATA_PROVIDER_DAILY_CAP",
		planes: ["execution"],
		default: "500",
		description:
			"Per-provider daily call cap for the daemon's data-fred / data-fmp / data-newsapi tools.",
	},
	{
		name: "FRED_API_KEY",
		planes: ["execution"],
		secret: true,
		description:
			"Held by the daemon for the data-fred tool (from .env.data-keys); never forwarded to jobs.",
	},
	{
		name: "FMP_API_KEY",
		planes: ["execution"],
		secret: true,
		description:
			"Held by the daemon for the data-fmp tool; never forwarded to jobs.",
	},
	{
		name: "NEWSAPIORG_API_KEY",
		planes: ["execution"],
		secret: true,
		description:
			"Held by the daemon for the data-newsapi tool; never forwarded to jobs.",
	},
	{
		name: "DEBUG_SESSIONS",
		planes: ["execution", "cli"],
		description:
			"`1` prints each session's system prompt, dynamic context and prior messages.",
	},

	// ── Background jobs ─────────────────────────────────────────────────────
	{
		name: "MAGI_TOOL_URL",
		planes: ["job"],
		description:
			"Set by the daemon in a job's environment: the loopback Tool API address.",
	},
	{
		name: "MAGI_TOOL_TOKEN",
		planes: ["job"],
		secret: true,
		description:
			"Set by the daemon in a job's environment: the job's own scoped, revocable Tool API token.",
	},

	// ── Control plane ───────────────────────────────────────────────────────
	{
		name: "PORT",
		planes: ["control"],
		default: "3000",
		description: "HTTP port.",
	},
	{
		name: "CONTROL_API_KEY",
		planes: ["control"],
		required: true,
		secret: true,
		description:
			"Admin key (API and cockpit). Also the only identity that may raise a mission's ceiling above the platform ceiling.",
	},
	{
		name: "MONITOR_SIGNING_KEY",
		planes: ["control"],
		required: true,
		secret: true,
		description:
			"HMAC key for per-mission MonitorServer tokens (`openssl rand -hex 32`). Never forwarded to mission machines.",
	},
	{
		name: "FLY_API_TOKEN_MACHINES",
		planes: ["control"],
		secret: true,
		description: "Fly Machines API token scoped to the missions app.",
	},
	{
		name: "FLY_MISSIONS_APP_NAME",
		planes: ["control"],
		description: "The Fly app that hosts mission machines.",
	},
	{
		name: "FLY_MISSIONS_IMAGE",
		planes: ["control"],
		default: "registry.fly.io/<missions-app>:latest",
		description:
			"Image for new mission machines; pinned to a deployment tag by deploy-missions.sh / CI.",
	},
	{
		name: "FLY_REGION",
		planes: ["control"],
		default: "iad",
		description: "Region for new mission machines and volumes.",
	},
	{
		name: "LOCAL_EXECUTION",
		planes: ["control"],
		description:
			"`true` runs missions as local daemons instead of Fly machines (development).",
	},
	{
		name: "LOCAL_MISSIONS_DIR",
		planes: ["control"],
		default: "~/.magi/local",
		description: "Where local-execution missions keep their files.",
	},
	{
		name: "FIREBASE_SERVICE_ACCOUNT_KEY",
		planes: ["control"],
		secret: true,
		description:
			"Firebase Admin SDK service-account JSON on one line; required for Google sign-in.",
	},
	{
		name: "FIREBASE_PROJECT_ID",
		planes: ["control"],
		description:
			"Firebase project id when no service-account key is given (local verification).",
	},
	{
		name: "FIREBASE_CLIENT_API_KEY",
		planes: ["control"],
		description:
			"Public Firebase client value served to the browser via /firebase-config.js.",
	},
	{
		name: "FIREBASE_CLIENT_AUTH_DOMAIN",
		planes: ["control"],
		description:
			"Public Firebase client value; also allowed by the cockpit CSP.",
	},
	{
		name: "FIREBASE_CLIENT_PROJECT_ID",
		planes: ["control"],
		description: "Public Firebase client value.",
	},
	{
		name: "CSP_ENFORCE",
		planes: ["control"],
		default: "false",
		description:
			"`true` makes the cockpit CSP enforcing instead of report-only. Flip once `[csp] violation` logs are clean.",
	},
	{
		name: "PLATFORM_MAX_COST_CEILING_USD",
		planes: ["control"],
		default: "100",
		description:
			"Spend-cap ceiling written on every new mission and back-filled at start; only an admin may set a mission's ceiling above it (ADR-0034). New missions get a $25 cap.",
	},
	{
		name: "PLATFORM_ADMIN_USER_IDS",
		planes: ["control"],
		description:
			"Comma-separated Firebase UIDs that receive the Atlas storage alert and report section. Empty is valid but logged on every tick.",
	},
	{
		name: "ATLAS_STORAGE_LIMIT_MB",
		planes: ["control"],
		default: "10240",
		description:
			"Shared Atlas cluster storage quota for the atlas-storage-high check (M10 tier; 512 for an M0).",
	},
	{
		name: "RESOURCE_REPORT_HOUR_UTC",
		planes: ["control"],
		default: "12",
		description:
			"UTC hour at or after which the daily resource report is sent; a control plane down through that hour sends once it is back.",
	},
	{
		name: "TEMPLATE_ALLOWLIST",
		planes: ["control"],
		description:
			"Comma-separated template ids this deployment offers. Unset: every template on disk.",
	},
	{
		name: "GH_TOKEN",
		planes: ["control"],
		secret: true,
		description:
			"GitHub token (repo scope) for the copilots' issue tools; every write is confirmed in the cockpit first.",
	},
	{
		name: "GITHUB_REPO",
		planes: ["control"],
		default: "arnadu/magi_v3",
		description: "Repository the issue tools use.",
	},
	{
		name: "GITHUB_ISSUE_DAILY_CAP",
		planes: ["control"],
		default: "10",
		description:
			"Per-mission daily cap on GitHub issue writes proposed by a mission copilot.",
	},
];

const PLANE_LABEL: Record<EnvPlane, string> = {
	control: "control plane",
	execution: "mission daemon",
	cli: "CLI",
	job: "background job",
};

/** docs/env.md, rendered from the catalog. */
export function renderEnvDoc(catalog: readonly EnvVar[] = ENV_CATALOG): string {
	const esc = (s: string) => s.replace(/\|/g, "\\|");
	const rows = [...catalog]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((v) => {
			const flags = [v.required ? "required" : "", v.secret ? "secret" : ""]
				.filter(Boolean)
				.join(", ");
			return `| \`${v.name}\` | ${v.planes.map((p) => PLANE_LABEL[p]).join(", ")} | ${v.default ? `\`${esc(v.default)}\`` : "—"} | ${flags || "—"} | ${esc(v.description)} |`;
		});
	return [
		"# Environment variables",
		"",
		"Generated from `packages/agent-config/src/env-catalog.ts` — edit that file and run",
		"`npm run docs:env`; a unit test fails when this page, the catalog and the code disagree.",
		"Secrets are never logged and never reach agent tool or job subprocesses (those get only",
		"`PATH`, `HOME` and, for jobs, the Tool API pair).",
		"",
		"| Variable | Read by | Default | Flags | Meaning |",
		"|---|---|---|---|---|",
		...rows,
		"",
	].join("\n");
}
