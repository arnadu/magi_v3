# MAGI V3

**An autonomous multi-agent system for long-horizon research and operations missions.**

MAGI runs teams of AI agents that collaborate on shared missions — delegating tasks, sharing artifacts, and operating unattended for hours or days. The anchor use case is an equity research team: four agents producing daily market briefs, sector reports, and event-driven alerts with full citation lineage.

This is a working prototype, not a polished product. It gets real things done, and it breaks in interesting ways.

---

## What it can do today

- **Run teams of agents** defined in a YAML config — each with a role, a system prompt, and a supervisor chain
- **Coordinate via a durable mailbox** backed by MongoDB; agents post structured messages to each other by role
- **Use tools**: shell (`Bash`), file I/O, web fetch (Readability + PDF), image inspection (vision LLM), web search (Brave API), and headless browser interaction (Playwright/Stagehand) for JS-rendered pages and login flows
- **Persist conversations** across restarts — each agent's full turn history accumulates across wakeups
- **Sleep and wake on demand** via a MongoDB Change Stream — no polling, no wasted compute at rest
- **Schedule recurring tasks** via a cron-based delivery loop (e.g. "brief me every morning at 06:00")
- **Enforce OS-level isolation** between agents: each runs tools under a dedicated Linux user with `setfacl` ACLs
- **Discover and use skills** — versioned playbooks shared via a tiered workspace, injected into each agent's system prompt

---

## Design

Each agent is a role definition in a YAML file: a system prompt, an initial mental map, a supervisor, and a Linux user. Agents communicate through a structured mailbox (not free-form chat) — messages carry intent, artifact references, and deadlines. All durable state lives in MongoDB; worker processes are stateless and can be restarted at any point without losing context.

Tool execution is OS-isolated: shell commands run as a dedicated pool user (`magi-w1`, `magi-w2`, …) forked via `sudo`, with no access to API keys or other agents' workspaces. ACLs are enforced at the filesystem level by `setfacl`. The orchestrator and the tool executor are deliberately kept separate — the child process that runs Bash is clean.

The shared workspace is a git repository provisioned at mission startup. Agents commit artifacts, scripts, and reports to it, giving every work product a full provenance trail. Reusable workflows are published as skill playbooks (Markdown + scripts) at four tiers — platform, team, mission, and agent-local — and discovered automatically.

Web content is treated as untrusted by default. Every artifact from `FetchUrl` or `BrowseWeb` is wrapped in an `⚠ UNTRUSTED WEB CONTENT` header; `content.md` files carry a machine-readable untrusted-source comment to guard against prompt injection via artifact supply chain.

The architecture is backend-first and UI-last. The monitor is a single-page SSE dashboard. The real work product layer — inbox, report centre, alert centre — comes later, once the core loop is proven.

---

## Status

Sprints 1–8 of 12 are complete. The system runs end-to-end: agents coordinate, use tools, persist state, and wake on schedule. The equity research team (Lead Analyst, Economist, Junior Analyst, Data Scientist) is bootstrapped and producing daily NVDA briefs.

See [MAGI_V3_ROADMAP.md](MAGI_V3_ROADMAP.md) for the full sprint plan.

---

## ⚠ Safety warning

This system runs AI agents that execute shell commands, write files, browse the web, and send messages to each other — autonomously, for extended periods, with minimal human supervision.

- **Agents execute real shell commands** on your machine. A confused or manipulated agent can delete files, make network requests, or exhaust disk. Review `permittedPaths` before deploying.
- **Web content is untrusted.** The trust boundary headers are a mitigation, not a guarantee. Do not point agents at adversarial content and ask them to act on it without human review checkpoints.
- **API costs are real.** Set `MAX_COST_USD` in your environment. A misconfigured cron schedule can accumulate significant spend.
- **This is a prototype.** The security model has not been independently audited. Browser process isolation is a known gap (Playwright runs in the orchestrator process), documented and deferred.

Use this in a controlled environment. Do not expose the monitor port publicly without authentication.

---

## Prerequisites

```bash
# Node 20+, MongoDB (local or Atlas), optional Brave Search API key
npm install && npm run build

# For BrowseWeb (optional):
cd packages/agent-runtime-worker && npx playwright install chromium

# Copy and fill in:
cp .env.example .env   # ANTHROPIC_API_KEY, MONGODB_URI, optional BRAVE_SEARCH_API_KEY

# Dev pool users (Linux only — needed for OS isolation):
sudo scripts/setup-dev.sh
```

## Running a mission

```bash
# Single-turn CLI:
TEAM_CONFIG=config/teams/word-count.yaml npm run cli -- "count the words in greeting.txt"

# Persistent daemon (waits for messages, runs indefinitely):
TEAM_CONFIG=config/teams/equity-research.yaml npm run daemon
# Dashboard: http://localhost:4000 — click ▶ Start

# Post a message to a running daemon:
TEAM_CONFIG=config/teams/equity-research.yaml \
  npm run cli:post -- --to lead-analyst "What is NVDA's current recommendation?"

# Watch replies:
TEAM_CONFIG=config/teams/equity-research.yaml npm run cli:tail
```

## Tests

```bash
npm test                  # unit tests — no LLM, no network
npm run test:integration  # full stack — requires ANTHROPIC_API_KEY + MONGODB_URI
npm run lint
```

---

## Repository layout

```
packages/
  agent-runtime-worker/   — agent loop, tools, orchestrator, daemon, CLI
  agent-config/           — YAML team config loader (Zod schema)
  skills/                 — platform-tier skill playbooks
config/
  teams/                  — team YAML configs (word-count, equity-research, …)
docs/adr/                 — architecture decision records
scripts/                  — dev environment setup
```

---

*Built with [Claude Code](https://claude.ai/code). Inspired by the MAGI system from Neon Genesis Evangelion — three independent intelligences, one shared mission.*
