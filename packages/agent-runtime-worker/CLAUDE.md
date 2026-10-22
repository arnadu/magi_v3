# agent-runtime-worker

The mission daemon (one per mission machine), the orchestration loop, the agent runner, the
monitor server (port 4000, cockpit-facing) and the Tool API server (port 4001, background jobs).
Loaded on top of the root `CLAUDE.md` when working in this package.

## Commands

```bash
npm run build -w packages/agent-runtime-worker          # build first — the daemon, tool executor and PDF worker run from dist/

# Orchestration loop from the CLI with a team config
TEAM_CONFIG=$PWD/config/teams/test/word-count.yaml npm run cli -w packages/agent-runtime-worker -- "count the words" [--step]

# Daemon lifecycle
TEAM_CONFIG=$PWD/config/teams/... npm run daemon -w packages/agent-runtime-worker
TEAM_CONFIG=$PWD/config/teams/... npm run cli:reset -w packages/agent-runtime-worker -- --yes
TEAM_CONFIG=$PWD/config/teams/... npm run cli:post -w packages/agent-runtime-worker -- --to lead "message"
TEAM_CONFIG=$PWD/config/teams/... npm run cli:tail -w packages/agent-runtime-worker
MISSION_ID=... npm run cli:stop -w packages/agent-runtime-worker
TEAM_CONFIG=<yaml> MONGODB_URI=<uri> npm run cli:usage -w packages/agent-runtime-worker

npx tsc -p packages/agent-runtime-worker/tsconfig.json --noEmit   # typecheck without building
```

`npm run -w` runs in the package directory, so a relative `TEAM_CONFIG` resolves from there:
use `$PWD/…` from the repo root. `cli:post`/`cli:tail` take the mission id from the team
config; `cli:stop` takes `MISSION_ID`.

The daemon reads its config from MongoDB when `MISSION_ID` is set (control-plane missions,
ADR-0021) or from `TEAM_CONFIG` (local).

## Environment, operationally

Full list: [`docs/env.md`](../../docs/env.md). The ones that change behaviour:

- `MODEL` (default `claude-sonnet-4-6`), `VISION_MODEL` (default `claude-haiku-4-5-20251001`;
  FetchUrl, InspectImage, BrowseWeb — Anthropic or OpenRouter ids).
- `MAX_COST_USD` — local spending cap (pauses when reached); provisioned missions use the
  stored cap instead. `MAX_AGENT_RUN_SECONDS` — per-dispatch wall clock, default 4 h.
- `BRAVE_SEARCH_API_KEY` — enables SearchWeb.
- `MISSION_COPILOT_ENABLED` — `"false"` opts a mission out of the mission copilot (ADR-0016).
- `MONITOR_TOKEN` — per-mission token required on **every** monitor route, GETs and SSE
  included; injected by the control plane; mandatory whenever `FLY_APP_NAME` is set (the
  daemon refuses to start without it). Empty = no auth, local developer daemon only.
- `CONTROL_PLANE_URL` — where the mission copilot's GitHub-proxy and resize tools call;
  injected at machine creation, empty locally.
- Data API keys (`.env.data-keys`: `FRED_API_KEY`, `FMP_API_KEY`, `NEWSAPIORG_API_KEY`) are
  held by the daemon only and never forwarded to any subprocess, background jobs included;
  jobs reach the providers through the `data-fred`/`data-fmp`/`data-newsapi` Tool API proxies
  (CR-04/F-030).

## Agent identity and workspace

- `agent_id` — semantic identity (e.g. `lead-analyst`), stable across missions; also the
  default source of `linux_user`; constrained by Zod to a Linux-username-safe slug.
- `linux_user` — resolved by `resolveLinuxUsers()` (`src/linux-user.ts`): a dedicated
  per-agent user in production Docker (`ensureAgentUsers()`); locally, mapped deterministically
  onto the fixed pool `magi-w1..magi-wN` (`setup-dev.sh` never creates real users on a
  developer machine) — sorted, so the same team always lands on the same users, and it fails
  loudly rather than reuse a slot. `linuxUser` in a template is a legacy override.
- Private workdir: `$AGENT_WORKDIR/home/{linux_user}/missions/{id}/` (0700, read-denied to
  other agents). Shared mission folder: `$AGENT_WORKDIR/missions/{id}/shared/`.
- Shell tools fork `sudo -u <linuxUser> node tool-executor.js`; the child receives only `PATH`
  and `HOME`. ACLs via `setfacl`.
- Sudo boundary (CR-01): only the daemon identity (`magi-operator`) may invoke `sudo`, scoped to
  `(%magi-shared)` — any current agent identity, never root or an unrelated user. No agent or
  pool user holds a sudo grant of its own. See `docs/security/threat-model.md` TB-3.

## Conventions in this package

- One file per tool in `src/tools/`; a tool that may run longer than the loop's 2-minute default
  declares `maxRuntimeMs` (the loop aborts the call's signal at the limit — honour it).
- Platform prompts are files in `prompts/`, loaded with `loadPrompt()` (`src/prompts.ts`); see
  `prompts/README.md`. Tool descriptions stay beside their parameter schemas.
- Code that runs in a worker thread or child process (`pdf-worker.ts`, `tool-executor.ts`) is
  started from `dist/`, so tests that reach it need a build first (`npm run verify` builds).

## Known pitfalls

`cron-parser` named exports fail on Node 22 — import the default:

```typescript
import cronParser from "cron-parser";
const { parseExpression } = cronParser;
```
