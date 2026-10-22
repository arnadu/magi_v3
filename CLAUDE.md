# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MAGI V3 is an autonomous multi-agent system where teams of AI agents run long-horizon research and operations missions. The primary use case is an **equity research team** producing daily market briefs, weekly sector reports, and event-driven alerts.

**Key documents:**
- [MAGI_V3_SPEC.md](MAGI_V3_SPEC.md) — full technical specification (agent loop, Mental Map, tool system, identity, mailbox, artifacts)
- [MAGI_V3_ROADMAP.md](MAGI_V3_ROADMAP.md) — sprint roadmap and history
- [USER_GUIDE.md](USER_GUIDE.md) — developer quick-start (setup, build, run)
- [docs/implementation-history.md](docs/implementation-history.md) — sprint-by-sprint build log and key file descriptions
- [docs/env.md](docs/env.md) — every environment variable (generated, test-checked)
- [docs/practices/](docs/practices/) — the full working practices behind the rules below
- [docs/references.md](docs/references.md) — MAGI v2 and pi-mono reference material

**Where the rest of the guidance lives.** Each package has its own `CLAUDE.md`, loaded when you
work in it: [agent-runtime-worker](packages/agent-runtime-worker/CLAUDE.md) (daemon, CLI, agent
identity and sudo boundary, tools, prompts), [control-plane](packages/control-plane/CLAUDE.md)
(deployment, control-plane env, copilot), [agent-config](packages/agent-config/CLAUDE.md)
(schemas, MongoDB collections), [cockpit](packages/cockpit/CLAUDE.md),
[skills](packages/skills/CLAUDE.md), and [docs/security](docs/security/CLAUDE.md) (security
practice).

## Commands

```bash
npm run build             # compile all packages (tsc)
npm test                  # unit tests (no LLM calls, no network)
npm run test:integration  # integration tests — requires ANTHROPIC_API_KEY and MONGODB_URI in .env
npm run lint              # Biome check (lint + format); npm run lint:fix to auto-fix
npm run verify            # what pre-push and CI run: build, lint, tripwires, structure, typecheck, coverage

bash scripts/bootstrap.sh # full initial cloud setup; see docs/deployment.md
```

Push to `main` deploys dev through CI. Deployment, the daemon and CLI commands, and mission
reconciliation are in the package `CLAUDE.md` files above.

**Required env vars:** `ANTHROPIC_API_KEY`, `MONGODB_URI`, and one of `TEAM_CONFIG` (a team
config YAML — local/dev) or `MISSION_ID` (control-plane-provisioned missions; the daemon reads
its structured config from MongoDB, ADR-0021). Everything else: [docs/env.md](docs/env.md).

## Architecture

### Packages

- `packages/control-plane/` — Express API (missions CRUD + lifecycle), Fly Machines client, scheduler and resource-monitor ticks, reverse proxy, control-plane copilot
- `packages/agent-runtime-worker/` — daemon (persistent process), orchestration loop, agent runner, monitor server (port 4000), Tool API server (port 4001)
- `packages/agent-config/` — Zod schema for team YAML (`loadTeamConfig()`, `parseTeamConfig()`), stored-document types and collection names, model defaults, env catalog
- `packages/cockpit/` — the operator UI (Vite + React), served by the control plane
- `packages/skills/` — platform skills: every directory with a `SKILL.md` ships to every mission (not an npm workspace)

### Data flow

Daemon runs orchestration loop (Change Stream wake-up) → agent runner → inner loop (LLM↔tools)
→ isolated tool subprocess (`sudo -u <agent user>`, only `PATH`/`HOME`). Control plane provisions
Fly machines → proxy forwards cockpit traffic to the mission machine's port 4000. State lives in
MongoDB — the collection list is in [packages/agent-config/CLAUDE.md](packages/agent-config/CLAUDE.md).

See [MAGI_V3_SPEC.md](MAGI_V3_SPEC.md) for the full design.

---

## Sprint Roadmap

Full history: [MAGI_V3_ROADMAP.md](MAGI_V3_ROADMAP.md) and
[docs/implementation-history.md](docs/implementation-history.md). Sprints 1–28e and 28g are
done; this section tracks only what's active.

**Sprint 28f — Third-party audit remediation (close-out).** Re-scoped 2026-10-16; plan
`docs/plans/audit-oct26-remediation-plan.md`, findings F-032…F-072 in
`docs/security/findings.md`. Code done (every High fixed, gates and ratchets in CI,
decomposition, typed stored documents, contract tests, consistency matrix, #80/#82/#83/#79).
Remaining: the first whole-repo `/sprint-audit`, then `/sprint-close`.

**Sprint 28h — Remaining operational hardening (backlog).** G-5 out-of-band alerting (#3, #4),
onboarding flow, usage dashboard, CR-06 remainder (#78), CR-07 remainder (confirmation gates for
pause/resume/schedule-cancel, F-026), CR-08 (blocked on Sprint 29), #21, revisit #31 (OOM).

**Sprint 29 — Sensitive-data encryption + tenant credential isolation (not started, ADR-0026).**
Application-level encryption at rest, OpenRouter ZDR routing, and per-tenant credentials
(CR-04's harder half). Needs a research pass first.

**Post-MVP, after Sprint 29:** a generic operator-managed secret registry (see the roadmap).

---

## Working rules

These apply continuously, not at sprint close. Each has a full write-up in
[docs/practices/](docs/practices/); the triggers below are the part to keep in mind while coding.

**Code quality** ([detail](docs/practices/code-quality.md))
- Types model the domain — a union, interface or Zod shape over `string`; `any`/`!` only with a
  `biome-ignore` reason. Strict mode always.
- Interfaces before implementation: an awkward API means the abstraction is wrong.
- Every `console.error` says what failed, on what input, and the consequence — never `console.error(e)`.
- No invisible debt (a cast, TODO or hardcoded value is fixed or explained in place) and no
  fallbacks added to keep old tests green.
- Comments only for the non-obvious; never reference the current task or caller.
- `npm run lint` before committing (the pre-commit hook enforces it).

**Code structure** ([detail](docs/practices/code-structure.md), inventory in [docs/code-structure.md](docs/code-structure.md))
- Pause at a file near 500 lines or a function near 80–100 lines: one responsibility, or
  separable phases? Extract before adding more. The ratchet fails at 600 / 120.
- A new module born large, or a file grown by addition sprint after sprint, is a signal on its own.

**Security** ([detail](docs/security/CLAUDE.md)) — pause at each of these:
- New external HTTP call: user-influenced URL? `ssrf.ts`/`safe-http.ts` used? Secrets sent? Response parsed safely?
- New subprocess or `sudo` rule: minimum env? Exact command path? Agent-influenced arguments?
- New env var: which processes get it? Excluded from images? Never forwarded to tool or job children?
- New MongoDB query on external input: value only, never an operator or field name; scoped to `missionId`?
- New path from input: contained (`safe-path.ts`) after resolving symlinks?
- New port or public endpoint: authenticated? Loopback or network? Threat model updated in the same commit?
- Identity, ACL and OS isolation are never optional: a field needed for secure operation is required in the type and the schema.

**Operational resilience** ([detail](docs/practices/operational-resilience.md), FMEA in [docs/operational-resilience.md](docs/operational-resilience.md)) — ask:
- New background loop: what if it crashes, hangs or overlaps itself? Watchdog, timeout, lock?
- New persistence write: what does a crash mid-write leave? Is it atomic or compare-and-set?
- New scheduled action: what if the process is down when it fires — is there catch-up?
- New external dependency: failure mode when it's down, briefly or for long? Retry, degrade or freeze?
- New volume write: can it fill the disk, and is that monitored?
- New computation or tool call: can it hang? Timeout and AbortSignal, surfaced to the operator?
- A component's failure modes are in `docs/operational-resilience.md` before its sprint closes.

**Documentation** ([detail](docs/practices/documentation.md)) — in the same commit as the code:
ADRs for decisions between alternatives, the threat model for new boundaries/ports/`sudo` rules,
the resilience doc for new failure modes, `docs/env.md` (via `npm run docs:env`) for env vars,
the SPEC for agent capabilities and tools, `docs/code-structure.md` for structure decisions.

**Testing** ([detail](docs/practices/testing.md)) — unit tests are deterministic and offline;
integration tests make real LLM calls with deterministic outcomes and clean up by `missionId`.
Never test prompt wording or LLM choices; until the eval harness exists ([#45](https://github.com/arnadu/magi_v3/issues/45)),
don't claim coverage of research quality.

**Sprint close** is a confirmation pass ([checklist](docs/practices/sprint-closure.md); `/sprint-close`).

## Bug and Issue Tracking

GitHub Issues at [github.com/arnadu/magi_v3/issues](https://github.com/arnadu/magi_v3/issues),
labelled `bug`, `enhancement`, `deferred`, `ux` or `security` (security findings also go in
`docs/security/findings.md`). Both copilots can propose issues; every GitHub write is a pending
action the operator confirms in the cockpit. At sprint close, review open `deferred` issues.

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript throughout |
| Linter/formatter | Biome |
| Process supervision | Fly machine restart policy (production); none locally — the daemon runs in the foreground; node-cron (scheduling) |
| Browser automation | Playwright + Stagehand |
| State store | MongoDB |
| Cloud | Fly.io (control plane always-on; execution plane on-demand machines) |
| Isolation | Docker + Linux ACLs (`setfacl`) + `sudo` subprocess isolation |
