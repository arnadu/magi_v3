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

# Cloud deployment
bash scripts/bootstrap.sh             # full initial setup (creates apps, sets secrets, builds + deploys)
bash scripts/deploy-missions.sh       # ALWAYS use this to deploy the execution plane — builds image,
                                      # then pins FLY_MISSIONS_IMAGE on the control plane so new
                                      # missions use the fresh image (not a stale :latest tag).
                                      # Never use bare `flyctl deploy` for the missions app alone.
flyctl deploy --config fly.control-dev.toml  # deploy control plane only

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
- `MAX_AGENT_RUN_SECONDS` (per-dispatch wall-clock timeout; default 14400 = 4 h; aborts hung agent runs)
- `BRAVE_SEARCH_API_KEY` (enables SearchWeb; free tier: 2000 req/month)
- `FIREBASE_SERVICE_ACCOUNT_KEY` (control plane only; Firebase Admin SDK service account JSON, minified to one line — required for Google Sign-In)
- `FIREBASE_CLIENT_API_KEY`, `FIREBASE_CLIENT_AUTH_DOMAIN`, `FIREBASE_CLIENT_PROJECT_ID` (control plane only; served to the browser via `/firebase-config.js`; public client-side values)
- `MONITOR_SIGNING_KEY` (control plane only; HMAC key for per-mission MonitorServer tokens — generate with `openssl rand -hex 32`; never forwarded to execution plane machines)
- `GH_TOKEN` (control plane only; GitHub personal access token with `repo` scope — used by copilot's `ListIssues`/`CreateIssue`/`CloseIssue`/`AddIssueComment` tools; optional but required for issue tracking)
- `GITHUB_REPO` (control plane only; GitHub repo in `owner/repo` format; default `arnadu/magi_v3`)
- `FLY_MISSIONS_IMAGE` (control plane only; overrides the default `registry.fly.io/<missions-app>:latest` image used when provisioning execution plane machines — set to a specific deployment tag when `:latest` hasn't been updated yet)
- `MISSION_COPILOT_ENABLED` (execution plane; `"false"` opts a mission out of the mission copilot agent, ADR-0016 — default on since Sprint 26)
- `MONITOR_TOKEN` (execution plane; per-mission auth token for MonitorServer's mutating routes and the mission copilot's own tool calls to it — derived from `MONITOR_SIGNING_KEY` and injected by the control plane at machine creation; empty = no auth, local dev only)
- `CONTROL_PLANE_URL` (execution plane; base URL the mission copilot's GitHub-proxy tools call — injected by the control plane at machine creation from its own `FLY_APP_NAME`; empty in local dev, where the proxy isn't reachable)

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
- `agentTurnStats` — per-turn (per-wakeup) statistics, upserted incrementally during a turn (LLM call count, tokens, cost, peak context, tool counts/errors, files written, messages sent, URLs visited); one doc per `(missionId, agentId, turnNumber)`
- `missionStats` — lifetime per-agent totals (cost, LLM calls, turn count, consecutive zero-output turns), `$inc`-updated once at turn end; one doc per `(missionId, agentId)`

### Data flow

Daemon runs orchestration loop (Change Stream wake-up) → agent runner → inner loop (LLM↔tools) → isolated tool subprocess. Control plane provisions Fly machines → proxy forwards browser traffic to execution plane port 4000.

See [MAGI_V3_SPEC.md](MAGI_V3_SPEC.md) for the full technical design and [docs/implementation-history.md](docs/implementation-history.md) for per-file implementation notes.

## Cloud Deployment (Fly.io)

```bash
cp secrets.env.template secrets.env   # fill in ANTHROPIC_API_KEY, MONGODB_URI, CONTROL_API_KEY
bash scripts/bootstrap.sh             # creates apps, sets secrets, builds + deploys
```

Full guide (app naming, GitHub Actions, integration test environments, operations, cost, troubleshooting): [docs/deployment.md](docs/deployment.md)

---

## Sprint Roadmap

Full history: [MAGI_V3_ROADMAP.md](MAGI_V3_ROADMAP.md)

| Sprint | Status | Focus |
|--------|--------|-------|
| 21 | ✅ Done | Context management (in-session): `pruneEphemeralResults`, thinking-block stripping, mid-session prune at 160k tokens, `AnalyzeMemories` tool, extended thinking on `CLAUDE_SONNET` |
| 22 | ✅ Done | Copilot unification + config-driven tool library: copilot calls `runAgent` via `additionalTools`; `disabledTools` per-agent YAML; Tier A/B tool library documented in SPEC |
| 23 | ✅ Done | Auth + multi-user: Firebase Auth (Google OAuth), `userId` on missions, per-user scoping, one copilot per user (`copilot-{uid}`), `/api/usage`, `magi_session` cookie for dashboard tabs, `MONITOR_TOKEN` HMAC auth on MonitorServer, fix F-008/F-009/F-016/F-019/F-020; copilot token display + reflection threshold fix; timing-safe API key comparison; `executeAction` ownership fixes; deferred: #6 #7 |
| 24 | ✅ Done | Budget hardening + alignment signals: `StatsCollector` three-layer stats (`llmCallLog`/`agentTurnStats`/`missionStats`, incremental persistence); `LimitRule[]` framework (hard opt-in → abort turn / soft defaulted → copilot mailbox + dashboard `limit-alert`); per-turn + per-agent-lifetime cost caps; OpenRouter live pricing + `costEstimated` (#10 Track 1); copilot `PauseAgent`/`ResumeAgent`/`SetMissionBudget` (operator-confirmed). Deferred: G-2/G-3, #10 Track 2 |
| 25 | ✅ Done | File I/O + tracking: git-commit-on-sleep (hash/diff in `agentTurnStats`), shared `document-processor.ts` (text/CSV/image/PDF/XLSX/DOCX/ZIP, no truncation, describe-now/defer image policy, partial-processing markers; `FetchUrl` deduped onto it), upload→process→mailbox pipeline (monitor `/upload`), download backend (monitor `/download` — file + folder-zip). Deferred: `git show` file API + rich download UX → S26; G-4 → backlog |
| 26a | ✅ Done | Outcome cockpit (spine): `objectives` platform skill (file-based, git-versioned `sharedDir/objectives/` store — objective tree + tasks + KPIs + budget, append-only, no MongoDB collections); daemon `#my-objectives` mental-map sync (B1) + turn-end cost attribution with `--effort` split/carry-over/`allocate` staleness fallback/supervisor overhead (B2/B2b); copilot `ReviewObjectives`/`AssessKPI` tools (C1). Deferred (additive, per original plan): explicit `AskUser`/`needsReply` awaiting-input state |
| 26b | 🟡 In progress | Cockpit SPA shipped in the control-plane image: Objectives panel, Conversations rail (Messages read/unread + chat drawer — the managerial↔conversational pivot), Transcripts tab (LLM-log drill-down), Files panel (workspace tree, type-driven rendering, provenance — **read-only**), rich markdown (tables/Mermaid/KaTeX), Trace panel (cost+interaction overview → cumulative cost-over-time chart → turn bounding boxes + file/message/wakeup/anomaly marker lanes). Also closed 3 production incidents found along the way: unguarded LLM-call hang, orphaned-job recovery crash-loop + its root cause (unbounded data-factory subprocess fan-out), and a control-plane deploy pipeline gap (`workflow_dispatch` added after a bare `flyctl deploy` reverted the machine to a stale image). Remaining: Files panel direct-edit → notify-last-agent, mode auto-selection, Trace turn click-to-drill-down into `llmCallLog` |
| 27 | ⬜ Planned | Launch hardening: G-5 alerting, onboarding flow, usage dashboard, security review |

## Code Quality

Quality is applied **continuously during development**, not recovered at sprint close. These are the standards to meet as code is written.

**Types model the domain.** Before implementing a function, get the types right. Where `string` could be more specific — a discriminated union, a named interface, a Zod-validated shape — use it. Reach for `any` or `!` only when genuinely unavoidable; document why with a `biome-ignore` comment. TypeScript strict mode is always on; work with it, not around it.

**Interfaces before implementation.** When adding a module, sketch the interface first. If the API is awkward to use, the abstraction is wrong — fix the design, not the callers.

**Logging survives incidents.** Every `console.error` must answer: what operation failed, what input triggered it, what the downstream consequence is. `console.error(e)` is a placeholder. Prefer structured context: `[daemon] orchestration failed { missionId, agentId, error: e.message }`.

**No deferred debt.** A type cast, a `TODO`, or a hardcoded value is a deliberate trade-off that must be visible. Either fix it in the same commit, or leave a comment explaining the constraint. Invisible debt is worse than acknowledged debt.

**No fallbacks to accommodate tests.** When a hard requirement lands, fix the test. Code that silently degrades — optional fields, `?? default` catch-alls added specifically to keep old tests green — is debt with compounding interest.

**Comments on the non-obvious only.** Well-named identifiers explain the what. Add a comment only for: a hidden constraint, a subtle invariant, a non-obvious workaround, behaviour that would surprise a reader. Never reference the current task or caller — those belong in commit messages.

**Lint after every change session.** Run `npm run lint` before committing. The pre-commit hook enforces this, but earlier is better. Use `npm run lint:fix` for auto-fixable issues, then fix remaining errors manually.

---

## Security

Security is applied **continuously during development**. These are the triggers — moments where you pause and reason about security regardless of what feature you're building.

**New external HTTP call** — Is the URL user-influenced? Does `ssrf.ts` need updating (especially for new IPv6 ranges such as Fly WireGuard `fdaa:`)? Does the call transmit secrets? Is the response parsed safely?

**New subprocess or `sudo` rule** — What is the minimum env the child receives? Does the sudoers rule scope by exact command path? Can an agent influence the arguments?

**New env var introduced or forwarded** — Which processes receive it? Is it excluded from the Docker image (`.dockerignore`)? Is it scoped correctly (daemon-only; never forwarded to tool-executor children)?

**New MongoDB query using external input** — Is the input used only as a value, never as an operator or field name? Is the query scoped to `missionId`?

**New file path derived from input** — Is it validated by `checkPath` before use? Are symlinks resolved before the ACL check?

**New IPC port or public endpoint** — Is it authenticated? Loopback-only or network-accessible? Is the threat model updated in the same commit?

**Security properties are never optional.** Identity, ACL, and OS isolation are always enforced. If a field is required for correct secure operation, it is `required` in the TypeScript type and in the Zod schema — never made optional to ease testing.

See `docs/security/CLAUDE.md` for the full security practice, and `/security-review`, `/security-audit`, `/threat-model` commands.

---

## Operational Resilience

Operational resilience is applied **continuously during development**. These are the triggers — moments where you pause and reason about failure modes regardless of what feature you're building.

**New long-running process or background loop** — What happens if it crashes or hangs? Is there a watchdog or timeout? Does a stale PID or lock file block the next startup?

**New persistence write** — Is there an atomicity window where a crash leaves state inconsistent? What is lost vs. preserved if the process is killed mid-write? Is the write in a `.finally()` block?

**New scheduled or time-driven action** — What happens if the process is down when the trigger fires? Is there a catch-up scan on restart, or is the action silently skipped?

**New external dependency** — What is the failure mode when the dependency is unavailable (transient vs. extended)? Does the calling code retry? Does it degrade gracefully or freeze?

**New file or volume write** — Can the volume fill up? Is there any monitoring or alerting? What happens to the mission if writes start failing?

**New in-process computation or tool call** — Can it hang indefinitely? Is it guarded by a timeout and AbortSignal? Is the timeout surfaced to the operator?

**Operational resilience is never optional.** When a new component reaches production, its failure mode must be documented in `docs/operational-resilience.md` before the sprint closes.

See `docs/operational-resilience.md` for the full FMEA analysis and gap backlog. Use `/operational-resilience` to review and update the document after a sprint.

---

## Documentation

Documentation updates go in the **same commit as the code change**. Documentation written a week later is written from memory.

**What belongs where:**

| What changed | Where to document |
|---|---|
| New architectural decision (technology, schema, design pattern) | New ADR in `docs/adr/`; link from sprint table |
| New trust boundary, external service, `sudo` rule, or IPC port | `docs/security/threat-model.md` |
| New component with failure modes, new external dependency, new scheduled action | `docs/operational-resilience.md` |
| New or changed env var, CLI flag, or build command | `CLAUDE.md` Commands section |
| New cloud deployment step or Fly.io operational quirk | `docs/deployment.md` |
| New agent capability, tool, or inter-agent protocol | `MAGI_V3_SPEC.md` (relevant section) |
| Subtle code invariant that would surprise a reader | Inline comment in the source |
| Superseded design or technology | Mark the ADR `SUPERSEDED`; update `CLAUDE.md` if the section is stale |

Aim for: **top-down architecture** (mental model before implementation detail), **subtleties surfaced** (non-obvious constraints and invariants), **operations covered** (install, run, debug, scale). A new person should understand _why_ first, then _what_, then _how_.

---

## Sprint Closure Checklist

Sprint close is a **confirmation pass** — this work should already be done. If a check fails here, that is a process gap to address going forward, not just a box to check now.

1. **Lint and tests pass** — `npm run lint && npm test`
2. **Security review confirmed** — `/security-review` was run for any new external surface during the sprint; CRITICAL/HIGH findings are fixed; others are logged in `docs/security/findings.md`
3. **Threat model current** — any new external HTTP call, `sudo` rule, process user, or IPC port was documented in `docs/security/threat-model.md` in the same commit as the code
4. **Operational resilience current** — run `/operational-resilience`; any new component's failure modes are documented in `docs/operational-resilience.md`; any closed gaps are removed from the gap table
5. **ADRs written** — any decision between concrete alternatives has an ADR in `docs/adr/`; superseded ADRs are marked
6. **CLAUDE.md sprint table** — mark `✅ Done` with a one-line summary

Use `/sprint-close` to run checks 1–2 automatically.

---

## Testing Approach

Three tiers:

- **Unit tests** — pure, deterministic logic only (config validation, ACL policy, HTML patching). `npm test`, no LLM calls, no network.
- **Integration tests** — real LLM calls with deterministic-outcome prompts. Full stack including tool execution and persistence. `npm run test:integration` — requires `ANTHROPIC_API_KEY` and `MONGODB_URI`. Each test uses a unique `missionId`; `afterEach` cleans up with `deleteMany({ missionId })`.
- **Dashboard UI test** (`tests/dashboard.integration.test.ts`) — headless Playwright test that spins up a real `MonitorServer` + orchestration loop on a free port and drives the full operator-message → agent-reply round-trip through the browser UI. Run with `npm run test:integration -- "dashboard"`. Also requires pool users (`setup-dev.sh`). Use this when debugging or changing the dashboard to confirm the SSE message flow end-to-end without a running daemon.
- **Evaluation tests** (`eval/`) — golden scenarios for structural/policy outcomes. Run on demand, not in CI.

Test runner: **vitest** — native ESM, no build step. Config: `vitest.config.ts` (unit), `vitest.integration.config.ts` (integration). Setup file: `vitest.setup.ts` loads `.env` and polyfills `File` for Node 18.

Do not write tests for prompt wording, LLM tool selection choices, or report content quality — those belong in the evaluation harness.

## Bug and Issue Tracking

Bugs and deferred improvements are tracked as **GitHub Issues** at
[github.com/arnadu/magi_v3/issues](https://github.com/arnadu/magi_v3/issues).

Label conventions:

| Label | Use for |
|-------|---------|
| `bug` | Broken behaviour |
| `enhancement` | Improvement to existing functionality |
| `deferred` | Known gap, accepted for now, queued for a future sprint |
| `ux` | Presentation or interaction issue |
| `security` | Security finding (link to `docs/security/findings.md`) |

The **copilot** has built-in `ListIssues`, `CreateIssue`, `CloseIssue`, and `AddIssueComment`
tools and will proactively raise issues when it encounters bugs during troubleshooting.
Execution-plane agents can use the `github-issues` platform skill (`packages/skills/github-issues/`).

When closing a sprint, check open `deferred` issues to decide if any should be promoted
into the upcoming sprint's scope.

---

## Known Pitfalls

**`File is not defined` on Node 18**
The daemon entry point uses `--import ./dist/node-polyfill.js`. If you see this from a different entry point, add the same `--import` flag.

**`cron-parser` named export error on Node 18/22**
```typescript
import cronParser from "cron-parser";
const { parseExpression } = cronParser;
```

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
