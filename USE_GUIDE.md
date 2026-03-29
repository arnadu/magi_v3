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

### BrowseWeb tool (optional)

Enables JS-rendered page browsing and interactive browser automation. Without this, the `BrowseWeb` tool is silently absent from the agent's toolbox; all other tools work normally.

**Step 1 — install the Chromium binary** (~200 MB, pinned version):

```bash
cd packages/agent-runtime-worker
npx playwright install chromium
```

**Step 2 — install OS-level system dependencies** (required on Linux/WSL/servers; may already be present on desktop systems):

```bash
cd packages/agent-runtime-worker
npx playwright install-deps chromium
```

This installs packages like `libnspr4`, `libnss3`, `libatk1.0-0`, and other shared libraries that Chromium headless shell requires. Requires `sudo` (the command prompts automatically). Without this step, Chromium crashes on launch with a missing `.so` error.

Run both commands once after cloning; re-run after Playwright version upgrades.

> **Production / Docker note:** In a Dockerfile, run both commands during the image build. The `install-deps` step is equivalent to the official `playwright install-deps` or adding the packages listed in the Playwright docs for your distro. Use `--with-deps` shorthand: `npx playwright install --with-deps chromium`.

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

### Starting the daemon

The daemon is a blocking foreground process — it holds the terminal while it runs and prints all agent activity to stdout. The recommended workflow is to start it in a dedicated terminal (or tmux pane) and use separate terminals for `cli:post`, `cli:tail`, and `cli:stop`.

```bash
# Terminal 1 — daemon (stays open, logs here)
cd packages/agent-runtime-worker
TEAM_CONFIG=../../config/teams/equity-research.yaml npm run daemon
```

If you want to run it in the background and return to the same terminal:

```bash
TEAM_CONFIG=../../config/teams/equity-research.yaml npm run daemon &
# Bring it back to foreground: fg
# Or just use a second terminal — that's cleaner
```

### Sending messages

```bash
# Terminal 2 — operator commands
TEAM_CONFIG=../../config/teams/equity-research.yaml npm run cli:post -- "your message"

# Send to a specific agent instead of the default lead:
TEAM_CONFIG=../../config/teams/equity-research.yaml npm run cli:post -- --to economist "re-run macro research"
```

### Watching replies

```bash
TEAM_CONFIG=../../config/teams/equity-research.yaml npm run cli:tail          # user-facing messages only
TEAM_CONFIG=../../config/teams/equity-research.yaml npm run cli:tail -- --all # all inter-agent traffic
```

### Stopping the daemon

**Preferred — graceful shutdown via PID file:**

```bash
# From any terminal (daemon keeps running in Terminal 1):
TEAM_CONFIG=../../config/teams/equity-research.yaml npm run cli:stop
```

This sends SIGTERM to the daemon process, which finishes any in-progress agent turn, closes the MongoDB connection, writes a final usage summary, and removes the PID file cleanly.

**Dashboard stop button** also works — the ■ Stop button in the monitor UI (http://localhost:4000) sends the same shutdown signal.

**Ctrl+C** works if the daemon is in the foreground (Terminal 1) and not mid-turn. If it appears to hang, Ctrl+C a second time will force-exit.

**Last resort — if the port is still held after the above:**

```bash
lsof -ti tcp:4000 | xargs kill -9
```

This hard-kills every process holding port 4000. Only needed if the daemon was killed with Ctrl+Z (suspend, not terminate) or `kill -9` without letting it clean up.

> **Note:** the daemon now refuses to start if another instance is already running for the same mission. If you see `Already running as PID N`, either stop the existing daemon first (`npm run cli:stop`) or check whether it is truly dead (`kill -0 N`; if you get "No such process" the PID file is stale and will be cleaned up automatically on the next start).

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
