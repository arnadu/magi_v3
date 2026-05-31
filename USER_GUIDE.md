# MAGI V3 — Usage Guide

## Prerequisites

Copy `secrets.env.template` to `.env` and fill in the required values. At minimum you need `ANTHROPIC_API_KEY`, `MONGODB_URI`, and `CONTROL_API_KEY`. For the control plane UI (Google Sign-In), also fill in the four Firebase vars — see [docs/deployment.md §5](docs/deployment.md#5-firebase-authentication-setup) for where to get them.

Run the dev setup script **as root** to create pool users and configure passwordless sudo for agent isolation:

```bash
sudo bash scripts/setup-dev.sh
```

This creates pool users `magi-w1..w6` and the `magi-copilot` user, sets up `/missions/` with shared ACLs, creates `/home/magi-copilot/workdir` with the correct group permissions, and writes `/etc/sudoers.d/magi` so the orchestrator can fork tool processes as pool users without a password prompt. It is idempotent — safe to re-run at any time.

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

## Local execution mode (full stack without Fly.io)

`LOCAL_EXECUTION=true` makes the control plane write mission config to disk instead of provisioning a Fly machine. You start the daemon manually; the control plane proxy routes dashboard traffic to `127.0.0.1:4000`.

**Terminal 1 — control plane:**
```bash
LOCAL_EXECUTION=true FLY_API_TOKEN_MACHINES=dummy FLY_MISSIONS_APP_NAME=dummy \
node --import ./packages/agent-runtime-worker/dist/node-polyfill.js \
  packages/control-plane/dist/index.js
```

The control plane loads `.env` automatically via dotenv — the Firebase vars you set there are picked up at startup. No need to inline them in the command.

**Authenticate.** Open **http://localhost:3000** in your browser and click **Sign in with Google**. A Firebase OAuth popup opens; sign in with any Google account. Each account sees only its own missions. To skip Google auth (e.g. in scripts or CI), use `CONTROL_API_KEY` as a bearer token — it grants full admin visibility.

**Launch a session from the UI.** The terminal prints the daemon start command, e.g.:
```
[local-provision] Mission files written to: /home/you/.magi/local/my-mission-001/
[local-provision] Start the daemon in a separate terminal:
  TEAM_CONFIG=/home/you/.magi/local/my-mission-001/team.yaml \
  npm run daemon -w packages/agent-runtime-worker
```

**Terminal 2 — daemon:**
```bash
TEAM_CONFIG=/home/you/.magi/local/my-mission-001/team.yaml \
npm run daemon -w packages/agent-runtime-worker
```

The dashboard, copilot, and all lifecycle controls (suspend/resume/destroy) work normally. Config files are stored under `~/.magi/local/` by default; override with `LOCAL_MISSIONS_DIR`.

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

**Dashboard Kill button** also works — the ■ Kill button in the monitor UI (http://localhost:4000) shows a confirmation dialog and then sends the same shutdown signal.

**Ctrl+C** works if the daemon is in the foreground (Terminal 1) and not mid-turn. If it appears to hang, Ctrl+C a second time will force-exit.

**Last resort — if the port is still held after the above:**

```bash
lsof -ti tcp:4000 | xargs kill -9
```

This hard-kills every process holding port 4000. Only needed if the daemon was killed with Ctrl+Z (suspend, not terminate) or `kill -9` without letting it clean up.

> **Note:** the daemon now refuses to start if another instance is already running for the same mission. If you see `Already running as PID N`, either stop the existing daemon first (`npm run cli:stop`) or check whether it is truly dead (`kill -0 N`; if you get "No such process" the PID file is stale and will be cleaned up automatically on the next start).

---

## Monitor dashboard

When the daemon is running, open **http://localhost:4000** to see the mission monitor dashboard.

### Layout

The dashboard is a two-panel layout:

**Left panel — Chat**
- **Thread list** (top): all mailbox messages grouped by subject, sorted by most-recent. Unread threads show a filled dot. Click a thread to open it.
- **Chat view** (middle): selected thread rendered as a chat conversation. Messages display sender, recipients, timestamp, and full body with markdown formatting.
- **Compose bar** (bottom): toggle recipient chips to select agents, type a message, and click Send to inject a mailbox message.

**Right panel — Detail**
- **Agent tabs**: one tab per agent showing name, role, and context-window usage bar. A `▶` prefix and green highlight indicate the agent is currently running. An amber name indicates context usage above 75%.
- **Mission tab**: mission-level overview.
- **Content tabs** (below agent/mission tabs):
  - Agent selected → **Activity** | **Mental Map** | **Files**
  - Mission selected → **Schedule** | **Files** | **Log** | **Stats**

### Content tabs

| Tab | What it shows |
|-----|--------------|
| Activity | Collapsible sessions tree: each session shows LLM call count, tool calls, token usage, and cost. Expand a session to see individual LLM calls and tool call details. |
| Mental Map | The agent's current mental map rendered as an HTML iframe. |
| Files (agent) | Browse the agent's private workdir. Click directories to navigate; click files to preview (text/markdown rendered, images shown inline). |
| Files (shared) | Browse the mission's shared directory. Same navigation as above. |
| Schedule | Table of pending scheduled messages. Click Cancel to delete an entry immediately. |
| Log | Tail of `daemon.log` (last 300 lines). Refresh button at top. |
| Stats | Per-agent cost and context breakdown; mission total and spending cap. |

### Header controls

| Control | Effect |
|---------|--------|
| `▶ Start` | Unblock a mission that is waiting for operator start (when `waitForStart` is configured). Disabled once running. |
| `✉ Send` | Focus the compose bar to send a message to agents. |
| `Step ○ / Step ● / ▶ Run` | Toggle step mode on/off; when step is enabled and waiting, the button changes to `▶ Run` to advance one step. |
| `■ Kill` | Confirmation dialog → graceful daemon shutdown. Red button. |

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

---

## Troubleshooting

**`sudo: a password is required` / `401 Unauthorized` from magi-job / sudo prompts in daemon terminal**

`setup-dev.sh` has not been run, or Node was upgraded since it last ran. Re-run:
```bash
sudo env NODE_BIN=$(which node) scripts/setup-dev.sh
```
The script is idempotent. Re-run it whenever you upgrade Node or switch nvm versions.

**`EACCES: permission denied, mkdir '/home/magi-copilot/workdir/skills/_platform'`**

Your user is not in the `magi-shared` group. `setup-dev.sh` now adds `$SUDO_USER` automatically, so re-running it fixes this. Then open a new terminal for the group change to take effect. Or manually:
```bash
sudo usermod -aG magi-shared $USER
# open a new terminal, then restart the control plane
```

**Port 4000 already in use**
```bash
lsof -ti tcp:4000 | xargs kill -9
```

**`magi-python3` fails / PEP 668 error**

`magi-python3` must be a wrapper script, not a symlink — Debian 12+ forbids pip into system Python. Re-run `setup-dev.sh` to recreate `/opt/magi/venv` and the wrapper at `/usr/local/bin/magi-python3`.

**"Fly API returned 401" when launching a mission**

The control plane was started with `FLY_API_TOKEN_MACHINES=dummy`. Use local execution mode instead (see below), or start without the dummy overrides to use real Fly credentials.

**Templates not appearing in the UI after a database reset**

The control plane seeds templates from `config/teams/*.yaml` on startup. If you dropped the database, just restart the control plane — seeding is automatic and idempotent. Test configs under `config/teams/test/` are excluded from the UI by design.
