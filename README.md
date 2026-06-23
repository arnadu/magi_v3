# MAGI V3

**An autonomous multi-agent system for long-horizon research and operations missions.**

MAGI runs teams of AI agents that collaborate on shared missions — delegating tasks, sharing artifacts, and operating unattended for hours or days. The anchor use case is an equity research team: agents producing daily market briefs, sector reports, and event-driven alerts with full citation lineage.

This is a working prototype, not a polished product. It gets real things done, and it breaks in interesting ways.

---

## What it can do today

- **Run teams of agents** defined in a YAML config — each with a role, a system prompt, a supervisor chain, and per-agent tool/skill toggles
- **Coordinate via a durable mailbox** backed by MongoDB; agents post structured messages to each other (and the operator) by role
- **Use tools**: shell (`Bash`), file I/O, web fetch (Readability + PDF + vision), image inspection (vision LLM), web search (Brave API), headless browser (Playwright/Stagehand) for JS-rendered pages and login flows, an isolated `Research` sub-loop, and a background-job system for long-running data work
- **Persist conversations** across restarts — each agent's full turn history accumulates across wakeups, with session-boundary compaction and reflection, plus in-session pruning to stay under the context window
- **Sleep and wake on demand** via a MongoDB Change Stream — no polling, no wasted compute at rest
- **Schedule recurring tasks** via a cron-based delivery loop (e.g. "brief me every morning at 06:00")
- **Enforce OS-level isolation** between agents: each runs tools under a dedicated Linux user with `setfacl` ACLs, forked via `sudo` with no access to secrets
- **Discover and use skills** — versioned playbooks shared via a tiered workspace, injected into each agent's system prompt
- **Run in the cloud** — an always-on **control plane** (Express API + single-page UI) provisions on-demand **execution-plane** machines on Fly.io, one per mission, and reverse-proxies the live monitor dashboard
- **Multi-user** — Firebase (Google) auth, per-user mission scoping, and one privileged **copilot** assistant per user that can inspect missions, propose actions (operator-confirmed), and file GitHub issues
- **Account for spend** — every LLM call is logged with a full cost breakdown; per-turn and lifetime statistics are aggregated into dedicated collections for budgeting and observability
- **A data factory** — a Python adapter layer (FRED, FMP, yfinance, NewsAPI, GDELT, IMF, World Bank) feeding background data-refresh jobs via a loopback tool IPC server

---

## Design

Each agent is a role definition in a YAML file: a system prompt, an initial mental map, a supervisor, and a Linux user. Agents communicate through a structured mailbox (not free-form chat) — messages carry intent, artifact references, and deadlines. All durable state lives in MongoDB; worker processes are stateless and can be restarted at any point without losing context.

Tool execution is OS-isolated: shell commands run as a dedicated user (`magi-w1`, `magi-w2`, … in dev; per-agent users in production) forked via `sudo`, with no access to API keys or other agents' workspaces. ACLs are enforced at the filesystem level by `setfacl`. The orchestrator and the tool executor are deliberately kept separate — the child process that runs Bash is clean.

The shared workspace is a git repository provisioned at mission startup. Agents commit artifacts, scripts, and reports to it, giving every work product a provenance trail. Reusable workflows are published as skill playbooks (Markdown + scripts) at four tiers — platform, team, mission, and agent-local — and discovered automatically.

Web content is treated as untrusted by default. Every artifact from `FetchUrl` or `BrowseWeb` is wrapped in an `⚠ UNTRUSTED WEB CONTENT` header; `content.md` files carry a machine-readable untrusted-source comment to guard against prompt injection via the artifact supply chain.

The cloud architecture splits into two planes. The **control plane** is a small always-on Fly app: it owns mission CRUD and lifecycle, the cron scheduler, the per-user copilot, Firebase auth, and a reverse proxy. Each mission's **execution plane** is an on-demand Fly machine running the daemon, the monitor server (port 4000), and the tool IPC server (port 4001); it suspends when idle and its volume persists across suspend/resume. See [docs/adr/0013-cloud-execution-architecture.md](docs/adr/0013-cloud-execution-architecture.md).

---

## Status

Sprints 1–23 are complete: the system runs end-to-end locally and in the cloud — agents coordinate, use tools, persist state, wake on schedule, and are managed through a multi-user control plane with a per-user copilot. Sprint 24 (budget hardening + alignment signals) is in progress; the statistics-collector foundation (per-turn `agentTurnStats` + lifetime `missionStats`) has landed.

See [MAGI_V3_ROADMAP.md](MAGI_V3_ROADMAP.md) for the full sprint plan and the Sprint 24–26 "Agent Alignment and Efficiency" design notes.

---

## ⚠ Safety warning

This system runs AI agents that execute shell commands, write files, browse the web, and message each other — autonomously, for extended periods, with minimal human supervision.

- **Agents execute real shell commands.** A confused or manipulated agent can delete files, make network requests, or exhaust disk. Review `permittedPaths` before deploying.
- **Web content is untrusted.** The trust-boundary headers are a mitigation, not a guarantee. Do not point agents at adversarial content and ask them to act on it without human review checkpoints.
- **API costs are real.** Set `MAX_COST_USD` in your environment. A misconfigured cron schedule can accumulate significant spend.
- **This is a prototype.** The security model has had internal review (see `docs/security/`) but no independent audit. Browser process isolation is a known gap (Playwright runs in the orchestrator process), documented and deferred.

Use this in a controlled environment. The monitor and control-plane endpoints are authenticated; do not disable that.

---

## Prerequisites

**Required:**

- **Node.js 20+** — `node --version` to check
- **Anthropic API key** — get one at https://console.anthropic.com
- **MongoDB** — local (`mongod`) or a free Atlas cluster at https://www.mongodb.com/atlas. The default URI is `mongodb://localhost:27017`.

**Optional:**

- **Brave Search API key** — enables the `SearchWeb` tool. Free tier (2 000 req/month) at https://brave.com/search/api/
- **Playwright Chromium** — enables the `BrowseWeb` tool for JS-rendered pages
- **Data API keys** (`FRED_API_KEY`, `FMP_API_KEY`, `NEWSAPIORG_API_KEY` in `.env.data-keys`) — enable the data-factory adapters
- **Firebase + Fly.io credentials** — only for the multi-user cloud control plane (see [docs/deployment.md](docs/deployment.md))

**Linux only — OS isolation setup:**

The system runs each agent's shell tools as a dedicated OS user (`magi-w1`, `magi-w2`, …). This requires the pool users and a sudoers rule. `setup-dev.sh` creates them, sets up the Python venv used by the data factory, and configures `/etc/sudoers.d/magi`:

```bash
sudo env NODE_BIN=$(which node) scripts/setup-dev.sh
```

(Pass `NODE_BIN` explicitly — a bare `sudo` picks the wrong node under nvm.) This is required for integration tests and the full daemon.

**Install:**

```bash
git clone https://github.com/arnadu/magi_v3 && cd magi_v3
npm install && npm run build

cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY and MONGODB_URI at minimum

# Optional: headless browser support
cd packages/agent-runtime-worker && npx playwright install chromium && cd ../..
```

## Running a mission

Worker commands live in the `agent-runtime-worker` package — run them with
`-w packages/agent-runtime-worker` from the repo root (or `cd` into the package first).

```bash
# Single-turn CLI:
TEAM_CONFIG=config/teams/test/word-count.yaml \
  npm run cli -w packages/agent-runtime-worker -- "count the words"

# Persistent daemon (waits for messages, runs indefinitely):
TEAM_CONFIG=config/teams/equity-research.yaml npm run daemon -w packages/agent-runtime-worker
# Dashboard: http://localhost:4000 — click ▶ Start

# Post a message to a running daemon:
TEAM_CONFIG=config/teams/equity-research.yaml \
  npm run cli:post -w packages/agent-runtime-worker -- --to lead-analyst "What is NVDA's current recommendation?"

# Watch replies:
TEAM_CONFIG=config/teams/equity-research.yaml npm run cli:tail -w packages/agent-runtime-worker

# LLM usage / cost report:
TEAM_CONFIG=config/teams/equity-research.yaml npm run cli:usage -w packages/agent-runtime-worker
```

## Cloud deployment (Fly.io)

```bash
cp secrets.env.template secrets.env   # fill in ANTHROPIC_API_KEY, MONGODB_URI, CONTROL_API_KEY
bash scripts/bootstrap.sh             # create apps, set secrets, build + deploy
bash scripts/deploy-missions.sh       # deploy the execution-plane image (always use this script)
```

Full guide (app naming, GitHub Actions, auth, operations, cost, troubleshooting): [docs/deployment.md](docs/deployment.md).

## Tests

```bash
npm test                  # unit tests — no LLM, no network
npm run test:integration  # full stack — requires ANTHROPIC_API_KEY + MONGODB_URI (and pool users)
npm run lint
```

---

## Repository layout

```
packages/
  control-plane/          — Express API (missions CRUD + lifecycle), Fly client, cron scheduler, copilot, proxy, UI
  agent-runtime-worker/   — daemon, agent loop, tools, orchestrator, monitor server, tool IPC server, CLI
  agent-config/           — YAML team config loader (Zod schema)
  skills/                 — platform-tier skill playbooks
config/
  teams/                  — team YAML configs (equity-research, gold-digest, general-assistant; test/ for fixtures)
docs/
  adr/                    — architecture decision records
  deployment.md           — cloud deployment guide
  security/               — threat model, findings, security practice
  operational-resilience.md, implementation-history.md
scripts/                  — dev setup, bootstrap, deploy, template seeding
```

---

*Built with [Claude Code](https://claude.ai/code).*
