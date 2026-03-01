# MAGI V3 — Usage Guide

## Prerequisites

Copy `.env.example` to `.env` and fill in the required values:

```
ANTHROPIC_API_KEY=sk-ant-...
MONGODB_URI=mongodb+srv://...@cluster0.example.mongodb.net/magi_v3_dev
```

Run the dev setup script **as root** to create pool users and configure passwordless sudo for agent isolation:

```bash
sudo bash scripts/setup-dev.sh
```

This creates pool users `magi-w1..w6`, sets up `/missions/` with shared ACLs, and writes `/etc/sudoers.d/magi` so the orchestrator can fork tool processes as pool users without a password prompt. It is idempotent — safe to re-run at any time.

> **nvm users:** the sudoers rule pins the exact `node` binary path. If you upgrade Node via nvm, re-run the script to update the entry, otherwise tool execution will fail.

Build all packages:

```bash
npm run build
```

---

## Single-run CLI

Runs a task to completion and exits. All agent activity is logged to stdout.

```bash
cd packages/agent-runtime-worker
TEAM_CONFIG=../../config/teams/word-count.yaml npm run cli -- "count the words in greeting.txt"
```

Pause after each agent turn to inspect state:

```bash
TEAM_CONFIG=../../config/teams/word-count.yaml npm run cli -- "count the words in greeting.txt" --step
```

---

## Watching messages in a second terminal

`cli:tail` connects directly to MongoDB and prints messages as they are inserted — no daemon required.

**User-facing messages only (what the team reports back to you):**

```bash
cd packages/agent-runtime-worker
TEAM_CONFIG=../../config/teams/word-count.yaml npm run cli:tail
```

**All inter-agent traffic (Lead ↔ Worker, tool calls, etc.):**

```bash
TEAM_CONFIG=../../config/teams/word-count.yaml npm run cli:tail -- --all
```

Press `Ctrl+C` to stop tailing.

---

## Persistent daemon

Starts the team and keeps it running indefinitely. Sleeps on a MongoDB Change Stream when the inbox is empty; wakes automatically when a new message arrives.

**Start the daemon:**

```bash
cd packages/agent-runtime-worker
TEAM_CONFIG=../../config/teams/word-count.yaml npm run daemon
```

**Send a message to the team (from any terminal):**

```bash
TEAM_CONFIG=../../config/teams/word-count.yaml npm run cli:post -- "count the words in greeting.txt"
```

Send to a specific agent instead of the default lead:

```bash
TEAM_CONFIG=../../config/teams/word-count.yaml npm run cli:post -- --to worker "recount the file"
```

**Watch replies:**

```bash
TEAM_CONFIG=../../config/teams/word-count.yaml npm run cli:tail
```

---

## Available team configs

| Config | Agents | Purpose |
|--------|--------|---------|
| `config/teams/word-count.yaml` | lead, worker | Dev smoke-test: count words in a file |
| `config/teams/fetch-share.yaml` | lead, analyst | Fetch a PDF and inspect page images |
| `config/teams/skills-test.yaml` | lead, worker | Skill creation and git-provenance workflow |

---

## Tests

```bash
npm test                   # unit tests — no LLM, no network
npm run test:integration   # integration tests — requires ANTHROPIC_API_KEY + MONGODB_URI
npm run lint               # Biome lint check
npm run lint:fix           # Biome auto-fix
```

Run a single integration test file:

```bash
npx vitest run --config vitest.integration.config.ts \
  packages/agent-runtime-worker/tests/multi-agent.integration.test.ts
```
