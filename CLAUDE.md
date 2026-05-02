# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MAGI V3 is an autonomous multi-agent system where teams of AI agents run long-horizon research and operations missions. The primary use case is an **equity research team** producing daily market briefs, weekly sector reports, and event-driven alerts.

**Key documents:**
- [MAGI_V3_SPEC.md](MAGI_V3_SPEC.md) — full technical specification (agent loop, Mental Map, tool system, identity, mailbox, artifacts)
- [MAGI_V3_ROADMAP.md](MAGI_V3_ROADMAP.md) — sprint roadmap and history
- [USER_GUIDE.md](USER_GUIDE.md) — developer quick-start (setup, build, run)
- [docs/implementation-history.md](docs/implementation-history.md) — sprint-by-sprint build log and key file descriptions
- [docs/references.md](docs/references.md) — MAGI v2 and pi-mono reference material

## Commands

```bash
npm run build             # compile all packages (tsc)
npm test                  # unit tests (no LLM calls, no network)
npm run test:integration  # integration tests — requires ANTHROPIC_API_KEY and MONGODB_URI in .env
npm run lint              # Biome check (lint + format)
npm run lint:fix          # Biome auto-fix

# CLI — run the orchestration loop with a team config
cd packages/agent-runtime-worker && npm run build   # build first
TEAM_CONFIG=config/teams/test/word-count.yaml npm run cli -- "count the words"
TEAM_CONFIG=config/teams/test/word-count.yaml npm run cli -- "count the words" --step

# Daemon lifecycle
TEAM_CONFIG=... npm run daemon -w packages/agent-runtime-worker
TEAM_CONFIG=$PWD/config/teams/... npm run cli:reset -w packages/agent-runtime-worker -- --yes
MISSION_ID=... npm run cli:post -w packages/agent-runtime-worker -- --to lead "message"
MISSION_ID=... npm run cli:tail -w packages/agent-runtime-worker
TEAM_CONFIG=<yaml> MONGODB_URI=<uri> npm run cli:usage -w packages/agent-runtime-worker

# Type-check without building
npx tsc -p packages/agent-runtime-worker/tsconfig.json --noEmit
```

**Required env vars:** `ANTHROPIC_API_KEY`, `MONGODB_URI`, `TEAM_CONFIG`

**Optional env vars:**
- `MODEL` (default: `claude-sonnet-4-6`)
- `VISION_MODEL` (default: `claude-haiku-4-5-20251001`; used by FetchUrl, InspectImage, BrowseWeb; accepts Anthropic or OpenRouter model IDs)
- `AGENT_WORKDIR` (default: cwd)
- `MONITOR_PORT` (default: 4000; must be 1–65535)
- `TOOL_PORT` (default: 4001; must be 1–65535)
- `MAX_COST_USD` (spending cap; triggers budget-pause when reached)
- `BRAVE_SEARCH_API_KEY` (enables SearchWeb; free tier: 2000 req/month)

**Data API keys** (forwarded to background jobs only — never to agent tool subprocesses):
Defined in `.env.data-keys`: `FRED_API_KEY`, `FMP_API_KEY`, `NEWSAPIORG_API_KEY`

## Architecture

### Packages

- `packages/control-plane/` — Express API (missions CRUD + lifecycle), Fly Machines client, cron scheduler, HTTP reverse proxy, single-page UI
- `packages/agent-runtime-worker/` — daemon (persistent process), orchestration loop, agent runner, monitor server (port 4000), tool API server (port 4001)
- `packages/agent-config/` — Zod schema for team YAML; `loadTeamConfig()`, `parseTeamConfig()`
- `packages/skills/` — platform skills: `skill-creator`, `git-provenance`, `inter-agent-comms`, `run-background`, `schedule-task`

### Agent identity and workspace

- `agent_id` — semantic identity (e.g. `lead-analyst`), stable across missions
- `linux_user` — OS user; pool users (`magi-w1..w5`) in dev, per-agent in production
- Private workdir: `$AGENT_WORKDIR/home/{linux_user}/missions/{id}/`
- Shared mission folder: `$AGENT_WORKDIR/missions/{id}/shared/`
- ACL enforcement: `setfacl` + `sudo -u <linuxUser>` subprocess isolation (no secrets in child env)
- Shell tools fork `sudo -u <linuxUser> node tool-executor.js`; child process receives only `PATH` and `HOME`

### Storage (MongoDB collections)

- `conversationMessages` — full agent conversation history with compaction and reflection
- `mailbox` — inter-agent and operator messages
- `llmCallLog` — audit log of every LLM call with cost breakdown
- `scheduled_messages` — cron-based agent wakeups

### Data flow

Daemon runs orchestration loop (Change Stream wake-up) → agent runner → inner loop (LLM↔tools) → isolated tool subprocess. Control plane provisions Fly machines → proxy forwards browser traffic to execution plane port 4000.

See [MAGI_V3_SPEC.md](MAGI_V3_SPEC.md) for the full technical design and [docs/implementation-history.md](docs/implementation-history.md) for per-file implementation notes.

## Cloud Deployment (Fly.io)

**Full deployment guide** (environment strategy, GitHub Actions setup, integration test environments, operations, cost reference, troubleshooting): [docs/deployment.md](docs/deployment.md)

### One-command setup

```bash
cp secrets.env.template secrets.env   # fill in ANTHROPIC_API_KEY, MONGODB_URI, CONTROL_API_KEY + optional data keys
bash scripts/bootstrap.sh             # creates apps, sets secrets, builds + pushes image, deploys control plane
```

`bootstrap.sh` accepts `--suffix <name>` to create named instances. Prompted interactively if not passed.

### App naming convention

| Suffix | Apps | Purpose |
|--------|------|---------|
| `dev` | `magi-control-dev` / `magi-missions-dev` | CI target; auto-deployed on push to `main` |
| `test-<label>` | `magi-control-test-hello-world` / … | Isolated integration test environments |
| `prod-<usecase>` | `magi-control-prod-gold-digest` / … | Production missions |

### Launching a mission

The control plane UI at `https://magi-control-{suffix}.fly.dev` accepts Mission ID, Name, and Team config.

Via API:
```bash
curl -X POST https://magi-control-dev.fly.dev/api/missions \
  -H "X-API-Key: $CONTROL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"missionId":"hw-001","name":"Smoke test","teamConfig":"test/hello-world"}'
```

### Team config paths

Production team configs: `config/teams/{name}.yaml`. Test configs: `config/teams/test/{name}.yaml` (never shown in UI).

| Config | teamConfig value | Purpose |
|--------|-----------------|---------|
| `config/teams/gold-digest.yaml` | `gold-digest` | Production gold market mission |
| `config/teams/equity-research.yaml` | `equity-research` | Production equity research mission |
| `config/teams/test/hello-world.yaml` | `test/hello-world` | Smoke test (1 agent) |
| `config/teams/test/word-count.yaml` | `test/word-count` | Multi-agent integration test |

---

## Sprint Roadmap

| Sprint | Status | Focus |
|--------|--------|-------|
| 0 | ✅ Done | Architecture freeze: six ADRs in `docs/adr/` |
| 1 | ✅ Done | Inner loop: `runInnerLoop`, 3 tools, MongoDB persistence, CLI, integration test |
| 2 | ✅ Done | Multi-agent: YAML team config (Zod), mailbox, orchestration loop, supervisor-depth ordering, 5 tools |
| 3 | ✅ Done | Web search, fetch, artifacts: `FetchUrl`, `InspectImage`, `SearchWeb`; `@path` upload; artifact model |
| 4 | ✅ Done | Identity, workspace, ACL enforcement: OS-isolated tool execution, `AclPolicy`, `WorkspaceManager`, `tool-executor.ts` |
| 5 | ✅ Done | Agent Skills: discovery, 3 platform defaults; Bash-based access via sharedDir copy; `provision()` runs `git init` |
| 6 | ✅ Done | Persistent daemon (MongoDB Change Stream sleep), conversation persistence (ADR-0008), scheduling infra |
| 7 | ✅ Done | `BrowseWeb` (Stagehand/Playwright): JS rendering, interactive tasks, session persistence, SSRF blocking |
| 8 | ✅ Done | Equity research MVP: 4-agent NVDA team, `schedule-task` skill, daily brief + L/S rec + performance tracker |
| 9 | ✅ Done | Context management: session-boundary compaction, reflection (ADR-0009), LLM call audit log |
| 10 | ✅ Done | Agentic tools: Research tool (nested inner loop, isolated context, shared index) (ADR-0010) |
| 11 | ✅ Done | Dashboard UX (sessions tree, budget pause, mental map iframe); workspace persistence; `cli:reset` |
| 12 | ✅ Done | Data factory + secondary model + Tool IPC server + background jobs (ADR-0011) |
| 13 | ✅ Done | Hardening and launch prep |
| 14 | ✅ Done | Cloud Infrastructure MVP: Fly.io execution plane, control plane, proxy, scheduler |
| 15 | ✅ Done | Developer onboarding: `bootstrap.sh`, `.dockerignore`, daemon log viewer, test config relocation |

## Sprint Closure Checklist

Run these before marking a sprint done — not optional.

1. **Lint and tests pass** — `npm run lint && npm test`; fix all errors before closing
2. **Security review** — run `/security-review`; fix CRITICAL/HIGH findings; log others in `docs/security/findings.md`
3. **Threat model** — if the sprint added a new external HTTP call, a new `sudo` rule, a new process user, or a new IPC port: run `/threat-model` and commit the result
4. **ADR** — if the sprint made a decision between concrete alternatives (technology, schema, design pattern): write a new ADR in `docs/adr/` linked from the sprint table; mark any superseded ADRs
5. **CLAUDE.md sprint table** — mark the sprint `✅ Done` with a one-line summary

---

## Development Principles

**No fallbacks to accommodate tests.** When a sprint introduces a hard requirement, do not make it optional so old tests keep passing. Fix the test, not the production code. Code that silently degrades — optional fields, `?? default` catch-alls — written specifically so old tests keep passing is bad debt.

**No optional security.** Security properties (identity, ACL, OS isolation) are never opt-in or conditional. If a field is required for correct operation, it is `required` in the TypeScript type and in the Zod schema.

**No comments unless the why is non-obvious.** Only add a comment when it explains a hidden constraint, a subtle invariant, a non-obvious workaround, or behaviour that would surprise a reader. Never explain what the code does — well-named identifiers do that. Never reference the current task, fix, or caller — those belong in commit messages and PR descriptions.

**Keep documentation current.** Code changes that introduce new architecture, new trust boundaries, or new design decisions must be accompanied by documentation updates in the same commit. A sprint that builds something new without an ADR or threat model update is incomplete.

## Testing Approach

Three tiers:

- **Unit tests** — pure, deterministic logic only (config validation, ACL policy, HTML patching). `npm test`, no LLM calls, no network.
- **Integration tests** — real LLM calls with deterministic-outcome prompts. Full stack including tool execution and persistence. `npm run test:integration` — requires `ANTHROPIC_API_KEY` and `MONGODB_URI`. Each test uses a unique `missionId`; `afterEach` cleans up with `deleteMany({ missionId })`.
- **Evaluation tests** (`eval/`) — golden scenarios for structural/policy outcomes. Run on demand, not in CI.

Test runner: **vitest** — native ESM, no build step. Config: `vitest.config.ts` (unit), `vitest.integration.config.ts` (integration). Setup file: `vitest.setup.ts` loads `.env` and polyfills `File` for Node 18.

Do not write tests for prompt wording, LLM tool selection choices, or report content quality — those belong in the evaluation harness.

## Known Pitfalls

**Pool users and setup-dev.sh (local dev)**

All three symptoms below — `sudo: a password is required`, `401 Unauthorized` from magi-job, and sudo password prompts in the daemon terminal — mean `setup-dev.sh` has not been run (or not since pool users / wrappers were added). Always run with:
```bash
sudo env NODE_BIN=$(which node) scripts/setup-dev.sh
```
Re-run whenever you upgrade Node or switch nvm versions (the wrapper `/usr/local/bin/magi-node` is updated in-place; plain `sudo` strips nvm from PATH and would exec the wrong node). The `/etc/sudoers.d/magi` must include `Defaults:%magi-shared !authenticate` to suppress PAM prompts for commands that will be denied.

**Port 4000 already in use**
```bash
lsof -ti tcp:4000 | xargs kill -9
```

**`File is not defined` on Node 18**
The daemon entry point uses `--import ./dist/node-polyfill.js`. If you see this from a different entry point, add the same `--import` flag.

**`cron-parser` named export error on Node 18/22**
```typescript
import cronParser from "cron-parser";
const { parseExpression } = cronParser;
```

**PEP 668 / `magi-python3` must be a wrapper script, not a symlink**
Debian 12+ forbids pip into system Python. Setup: `sudo env NODE_BIN=$(which node) scripts/setup-dev.sh` creates `/opt/magi/venv` and writes the wrapper `/usr/local/bin/magi-python3`. A symlink breaks venv path resolution — re-run `setup-dev.sh` to fix.

**Fly.io: app-level secrets NOT injected into Machines API machines**
`flyctl secrets set` applies to `flyctl deploy`-managed machines only. `fly-machines.ts` explicitly passes all required secrets in the machine `env` at creation time. For execution-plane apps (machines-only, no deploy), use `flyctl machine update <id> --env KEY=value` to update machine env directly.

**Fly.io: `flyctl secrets set --stage` + `flyctl deploy` drops staged secrets**
Always use `flyctl secrets set` without `--stage` before deploying a control plane app.

**Fly.io: V2 apps require `cpu_kind`/`cpus`/`memory` in `[[vm]]`, not `size`**
```toml
[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "256mb"
```
The V1 `size = "shared-cpu-1x"` field is silently accepted but results in no machine being created.

**All control planes sharing the same `MONGODB_URI` share the `missions` collection**
Use separate MongoDB databases (different URI `dbName` suffix) for true isolation between prod and dev.

**Test instances can reuse the dev worker image**
```bash
flyctl secrets set -a magi-control-test-hello-world FLY_MISSIONS_IMAGE="registry.fly.io/magi-missions-dev:latest"
```

## Quality Requirements

- Every claim in a report requires source references and links to evidence lineage in the UI
- Confidence scores required for forecasts
- Conflicting signals force a review task (no silent averaging)
- Alert actions (`ack`, `escalate`, `snooze`) must be durable and auditable
- Permission denials must be visible and actionable, not silent failures

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript throughout |
| Linter/formatter | Biome |
| Process supervision | pm2 (local dev); node-cron (scheduling) |
| Browser automation | Playwright + Stagehand |
| State store | MongoDB |
| Cloud | Fly.io (control plane always-on; execution plane on-demand machines) |
| Container isolation | Docker + Linux ACLs (`setfacl`) + sudo subprocess isolation |
| Filesystem permissions | Linux ACLs (`setfacl`) |
