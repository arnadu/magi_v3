# Environment variables

Generated from `packages/agent-config/src/env-catalog.ts` — edit that file and run
`npm run docs:env`; a unit test fails when this page, the catalog and the code disagree.
Secrets are never logged and never reach agent tool or job subprocesses (those get only
`PATH`, `HOME` and, for jobs, the Tool API pair).

| Variable | Read by | Default | Flags | Meaning |
|---|---|---|---|---|
| `AGENT_WORKDIR` | mission daemon, CLI | `cwd` | — | Root of agent home directories and mission folders (`/missions` on Fly). |
| `ANTHROPIC_API_KEY` | control plane, mission daemon, CLI | — | required, secret | Anthropic API key for agents, the copilots and vision calls. |
| `APPS_ALLOW_NO_FIREWALL` | mission daemon | `false` | — | Local developer daemon only: "true" lets interactive apps start without the machine firewall (there is no magi-net helper off Fly). Ignored on Fly, where apps need the firewall on (ADR-0037). |
| `APPS_HOST_PORT` | apps host | `8080` | — | The apps host's internal port; Fly maps the public slots 20000-20099 onto it (fly.apps-dev.toml). |
| `APPS_HOST_URL` | control plane | — | — | The apps host's address without a port (e.g. https://magi-apps-dev.fly.dev): where the control plane sends the operator to open an app, on that app's port (ADR-0037). Unset: interactive apps cannot be opened on this deployment. |
| `APPS_SIGNING_KEY` | control plane, apps host | — | required, secret | Key the per-mission apps token is derived from (`deriveAppsToken`): the apps host sends that token to a mission's monitor server, and the control plane injects it into the machine as APPS_TOKEN. Never forwarded to mission machines itself. |
| `APPS_TICKET_KEY` | control plane, apps host | — | required, secret | HMAC key of the apps host's tickets and sessions (ADR-0037); the control plane signs tickets with the same key. Generate with `openssl rand -hex 32`. |
| `APPS_TOKEN` | mission daemon | — | secret | Per-mission token the apps host sends on every request it forwards to the monitor server's app hop (`/a/<capability>/`), derived from APPS_SIGNING_KEY and injected at machine creation (ADR-0037). Opens apps only; the monitor token does not open them. Empty on a Fly machine means no app can be opened; empty off Fly means no check (local developer daemon). |
| `ATLAS_STORAGE_LIMIT_MB` | control plane | `10240` | — | Shared Atlas cluster storage quota for the atlas-storage-high check (M10 tier; 512 for an M0). |
| `AUTH_TEST_USERS` | control plane | — | secret | Test-only sign-in for the local scanning stack: `<token>=test-<name>` pairs, comma-separated (tokens of 32+ characters). The control plane refuses to start with it when `FLY_APP_NAME` is set. Never set it on a deployment. |
| `BRAVE_SEARCH_API_KEY` | mission daemon, CLI | — | secret | Enables the SearchWeb tool (free tier: 2000 requests/month). Without it the tool is absent. |
| `COCKPIT_URL` | apps host | — | required | The cockpit's address (e.g. https://magi-control-dev.fly.dev): where the apps host sends an operator whose app session is missing, expired or refused, to open the app again. |
| `CONTROL_API_KEY` | control plane | — | required, secret | Admin key (API and cockpit). Also the only identity that may raise a mission's ceiling above the platform ceiling. |
| `CONTROL_PLANE_URL` | mission daemon | — | — | Base URL the mission copilot's GitHub-proxy tools call; injected at machine creation. Empty in local dev. |
| `CSP_ENFORCE` | control plane | `true` | — | The cockpit CSP is enforcing unless this is `false` (report-only: violations logged as `[csp] violation`, nothing blocked). Use `false` only temporarily, e.g. while adding a new source. |
| `DATA_PROVIDER_DAILY_CAP` | mission daemon | `500` | — | Per-provider daily call cap for the daemon's data-fred / data-fmp / data-newsapi tools. |
| `DEBUG_SESSIONS` | mission daemon, CLI | — | — | `1` prints each session's system prompt, dynamic context and prior messages. |
| `FIREBASE_CLIENT_API_KEY` | control plane | — | — | Public Firebase client value served to the browser via /firebase-config.js. |
| `FIREBASE_CLIENT_AUTH_DOMAIN` | control plane | — | — | Public Firebase client value; also allowed by the cockpit CSP. |
| `FIREBASE_CLIENT_PROJECT_ID` | control plane | — | — | Public Firebase client value. |
| `FIREBASE_PROJECT_ID` | control plane | — | — | Firebase project id when no service-account key is given (local verification). |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | control plane | — | secret | Firebase Admin SDK service-account JSON on one line; required for Google sign-in. |
| `FLY_API_TOKEN_MACHINES` | control plane | — | secret | Fly Machines API token scoped to the missions app. |
| `FLY_APP_NAME` | control plane, mission daemon, apps host | — | — | Set by Fly on every machine. Its presence means "running on Fly": the daemon requires MONITOR_TOKEN and enables volume alerts. |
| `FLY_MISSIONS_APP_NAME` | control plane | — | — | The Fly app that hosts mission machines. |
| `FLY_MISSIONS_IMAGE` | control plane | `registry.fly.io/<missions-app>:latest` | — | Image for new mission machines; pinned to a deployment tag by deploy-missions.sh / CI. |
| `FLY_REGION` | control plane | `iad` | — | Region for new mission machines and volumes. |
| `FMP_API_KEY` | mission daemon | — | secret | Held by the daemon for the data-fmp tool; never forwarded to jobs. |
| `FRED_API_KEY` | mission daemon | — | secret | Held by the daemon for the data-fred tool (from .env.data-keys); never forwarded to jobs. |
| `GH_TOKEN` | control plane | — | secret | GitHub token (repo scope) for the copilots' issue tools; every write is confirmed in the cockpit first. |
| `GITHUB_ALERTS_TOKEN` | control plane | — | secret | Read-only GitHub token for the repository's code-scanning and Dependabot alerts (a fine-grained token with only those two read permissions on `GITHUB_REPO`), used by `security.read-alerts`. Separate from `GH_TOKEN`. Unset: the route answers that alerts are not configured. |
| `GITHUB_ISSUE_DAILY_CAP` | control plane | `10` | — | Per-mission daily cap on GitHub issue writes proposed by a mission copilot. |
| `GITHUB_REPO` | control plane | `arnadu/magi_v3` | — | Repository the issue tools use. |
| `LOCAL_EXECUTION` | control plane | — | — | `true` runs missions as local daemons instead of Fly machines (development). |
| `LOCAL_MISSIONS_DIR` | control plane | `~/.magi/local` | — | Where local-execution missions keep their files. |
| `MAGI_POOL_SIZE` | mission daemon, CLI | `6` | — | Local dev: size of the magi-wN OS-user pool agents are mapped onto. |
| `MAGI_TOOL_TOKEN` | background job | — | secret | Set by the daemon in a job's environment: the job's own scoped, revocable Tool API token. |
| `MAGI_TOOL_URL` | background job | — | — | Set by the daemon in a job's environment: the loopback Tool API address. |
| `MAX_AGENT_RUN_SECONDS` | mission daemon, CLI | `14400` | — | Per-dispatch wall-clock timeout; a hung agent run is aborted. |
| `MAX_COST_USD` | mission daemon, CLI | — | — | Fallback spend cap when the mission config sets none (every control-plane mission has one, ADR-0034). The CLI stops the run when it is reached. |
| `MISSION_COPILOT_ENABLED` | mission daemon | `true` | — | `false` opts a mission out of the mission copilot (ADR-0016). |
| `MISSION_ID` | mission daemon, CLI | — | — | Control-plane-provisioned missions: the daemon reads its structured config from MongoDB (ADR-0021). One of MISSION_ID or TEAM_CONFIG is required. |
| `MODEL` | mission daemon, CLI | `claude-sonnet-4-6` | — | Default agent model when the mission config names none. |
| `MONGODB_URI` | control plane, mission daemon, CLI | — | required, secret | MongoDB connection string; the database name comes from the URI path. One shared Atlas cluster (M10 since 2026-10-17), one database per environment. |
| `MONITOR_PORT` | mission daemon | `4000` | — | MonitorServer port (1–65535). |
| `MONITOR_SIGNING_KEY` | control plane | — | required, secret | HMAC key for per-mission MonitorServer tokens (`openssl rand -hex 32`). Never forwarded to mission machines. |
| `MONITOR_TOKEN` | mission daemon | — | secret | Per-mission token required on every MonitorServer route, derived from MONITOR_SIGNING_KEY and injected at machine creation. Mandatory when FLY_APP_NAME is set; empty means no auth, for a local developer daemon only. |
| `NEWSAPIORG_API_KEY` | mission daemon | — | secret | Held by the daemon for the data-newsapi tool; never forwarded to jobs. |
| `OPENROUTER_API_KEY` | control plane, mission daemon, CLI | — | secret | Enables OpenRouter model ids for `model` / `visionModel`. |
| `PATH` | mission daemon | — | — | Passed through, alone with HOME, to agent tool and job subprocesses. |
| `PLATFORM_ADMIN_USER_IDS` | control plane | — | — | Comma-separated Firebase UIDs that receive the Atlas storage alert and report section. Empty is valid but logged on every tick. |
| `PLATFORM_MAX_COST_CEILING_USD` | control plane | `100` | — | Spend-cap ceiling written on every new mission and back-filled at start; only an admin may set a mission's ceiling above it (ADR-0034). New missions get a $25 cap. |
| `PLAYWRIGHT_BROWSERS_PATH` | mission daemon, CLI | `~/.cache/ms-playwright` | — | Where Playwright's Chromium is installed (BrowseWeb). The mission image sets /opt/ms-playwright so the daemon user can read it; BrowseWeb is not offered when no Chromium is found there. |
| `PORT` | control plane | `3000` | — | HTTP port. |
| `REFLECTION_THRESHOLD` | mission daemon, CLI | — | — | Override, in tokens, for the context size that triggers reflection; default is a fraction of the model's window. |
| `RESOURCE_REPORT_HOUR_UTC` | control plane | `12` | — | UTC hour at or after which the daily resource report is sent; a control plane down through that hour sends once it is back. |
| `TEAM_CONFIG` | mission daemon, CLI | — | — | Local/dev: path to a team config YAML. One of MISSION_ID or TEAM_CONFIG is required. |
| `TEAM_SKILLS_PATH` | mission daemon | `<team config dir>/skills` | — | Override for the team-tier skills directory. |
| `TEMPLATE_ALLOWLIST` | control plane | — | — | Comma-separated template ids this deployment offers. Unset: every template on disk. |
| `TOOL_PORT` | mission daemon | `4001` | — | Loopback Tool API server port for background jobs (1–65535). |
| `VISION_MODEL` | mission daemon, CLI | `claude-haiku-4-5-20251001` | — | Model for FetchUrl image captioning, InspectImage, OCR and BrowseWeb page understanding. Anthropic or OpenRouter id. |
