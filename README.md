# MAGI V3

**An autonomous multi-agent system for long-horizon research and operations missions.**

MAGI is a TypeScript backend that runs teams of AI agents. Each agent has a role, a persistent memory, a private workspace, and a mailbox. Agents delegate to each other, share artifacts, and collaborate on missions that can run unattended for days. The anchor use case is an equity research team — four agents producing daily market briefs, sector reports, and event-driven alerts with full citation lineage.

This is a working prototype, not a polished product. It gets real things done, and it breaks in interesting ways.

---

## What it can do today

- **Run teams of agents** defined in a YAML config — each with a role, a system prompt, and a supervisor chain
- **Coordinate via a durable mailbox** backed by MongoDB; agents post structured messages to each other by role
- **Use tools**: shell (`Bash`), file I/O, web fetch (Readability + PDF), image inspection (vision LLM), web search (Brave API), and headless browser interaction (Playwright/Stagehand) for JS-rendered pages and login flows
- **Persist conversations** across restarts — each agent's full turn history accumulates across daemon wakeups
- **Sleep on a Change Stream** and wake instantly when a new message arrives, consuming no resources at rest
- **Schedule recurring tasks** via a cron-based delivery loop (e.g. "brief me every morning at 06:00")
- **Enforce OS-level isolation** between agents: each runs tools under a dedicated Linux user with `setfacl` ACLs — one agent cannot read another's private workspace
- **Discover and use skills** — parameterised playbooks published to a shared workspace tier and injected into each agent's system prompt

---

## Key design decisions

**MongoDB over Temporal.** The original plan used Temporal for durable orchestration. After Sprint 0 we dropped it — a Change Stream sleep + node-cron covers every scheduling need with far less operational weight. This would need revisiting at scale.

**OS users for isolation, not containers.** Each agent executes shell tools as a dedicated Linux user (`magi-w1`, `magi-w2`, …). The agent process has no write access to another agent's home. API keys never appear in child process environments. Containerisation is deferred.

**Backend before UI.** No frontend exists yet. The monitor dashboard is a single-page status view over SSE. The real work product layer — inbox, report centre, alert centre — comes in Sprint 10.

**Stateless inner loop, persistent outer state.** Each agent turn loads its full conversation history from MongoDB, runs to completion, and saves the new messages. Workers are stateless; all durable state lives in MongoDB. This is the same principle as MAGI v2.

**Skills over tools for team-specific behaviour.** Low-frequency, team-specific workflows live in versioned Markdown playbooks (skills) committed to the shared workspace. High-frequency, latency-sensitive operations are tools. The threshold: >1 000 tokens of instruction = skill.

**Trust boundaries on all web content.** Every artifact from `FetchUrl` or `BrowseWeb` is wrapped in an `⚠ UNTRUSTED WEB CONTENT` header and the `content.md` file is prefixed with a machine-readable untrusted-source comment. Prompt injection via artifact supply chain is a real risk in autonomous systems.

---

## Roadmap

| Sprint | Status | Focus |
|--------|--------|-------|
| 0 | ✅ Done | Architecture freeze: six ADRs |
| 1 | ✅ Done | Inner loop: LLM→tool→LLM, 3 tools, MongoDB, CLI |
| 2 | ✅ Done | Multi-agent: team YAML, mailbox, orchestration, supervisor-depth ordering |
| 3 | ✅ Done | Web tools: `FetchUrl`, `InspectImage`, `SearchWeb`, `@path` upload |
| 4 | ✅ Done | Identity + ACL: OS-isolated tool execution, `AclPolicy`, `WorkspaceManager` |
| 5 | ✅ Done | Agent skills: four-tier discovery, three platform defaults, `git init` at provision |
| 6 | ✅ Done | Persistent daemon: Change Stream sleep, conversation persistence, `cli:post` |
| 7 | ✅ Done | `BrowseWeb`: Playwright/Stagehand, JS rendering, session persistence, SSRF blocking |
| 8 | ✅ Done | Equity research MVP: 4-agent NVDA team, playbook, code review hardening |
| 9 | | Reliability + evaluation harness (5-day unattended run) |
| 10 | | Work Product Layer UI |
| 11 | | Cloud burst and scale-out |
| 12 | | Hardening and launch prep |

Sprints 1–8 are complete. The system runs. Sprint 9 begins stress-testing it.

---

## ⚠ Safety warning

This system is designed to run AI agents that can execute shell commands, write files, browse the web, and send messages to each other — autonomously, for extended periods, with minimal human supervision.

**Read this before running anything:**

- **Agents execute real shell commands** on your machine, as real Linux users. A confused or manipulated agent can delete files, make network requests, install packages, or exhaust disk space. Review your `permittedPaths` ACL before deploying.
- **Web content is untrusted by design.** The prompt injection warning headers are a mitigation, not a guarantee. A sufficiently adversarial web page could influence agent behaviour. Do not point agents at untrusted content and ask them to act on it autonomously without human review checkpoints.
- **API costs are real.** Each agent turn makes LLM API calls. A runaway agent or a misconfigured cron schedule can accumulate significant spend. Set `MAX_COST_USD` in your environment.
- **Credentials must not leak to child processes.** The tool isolation (`sudo -u magi-wN node tool-executor.js`) is specifically designed to prevent this. Do not bypass it.
- **This is a prototype.** The security model has not been independently audited. Browser process isolation (Playwright runs in the orchestrator process) is a known gap, documented and deferred to Sprint 9.

Use this in a controlled environment. Do not expose the monitor dashboard port publicly without authentication.

---

## Prerequisites

```bash
# Node 20+, MongoDB (local or Atlas), optional Brave Search API key
npm install
npm run build

# For BrowseWeb (optional):
cd packages/agent-runtime-worker && npx playwright install chromium

# Copy and fill in:
cp .env.example .env   # ANTHROPIC_API_KEY, MONGODB_URI, optional BRAVE_SEARCH_API_KEY

# Dev pool users (Linux only — needed for OS isolation):
sudo scripts/setup-dev.sh
```

## Running a mission

```bash
# Single-turn CLI (useful for tests and one-shot tasks):
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
npm test                  # unit tests — no LLM, no network, fast
npm run test:integration  # full stack — requires ANTHROPIC_API_KEY + MONGODB_URI
npm run lint              # Biome check
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
