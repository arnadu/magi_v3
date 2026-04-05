# Equity Research Team — Operator Guide

This guide describes how to start and run the NVDA equity research mission.

---

## Prerequisites

```bash
# 1. Pool users + shared Python venv (run from repo root)
sudo env NODE_BIN=$(which node) scripts/setup-dev.sh
# Creates: magi-w1..w4, /opt/magi/venv, /usr/local/bin/magi-python3

# 2. Verify Python venv is working
magi-python3 -c "import yfinance, requests; print('ok')"

# 3. Playwright Chromium installed (needed for SEC EDGAR)
cd packages/agent-runtime-worker && npx playwright install chromium

# 4. Environment variables — two files:
# .env (orchestrator secrets — never forwarded to agent scripts)
ANTHROPIC_API_KEY=...
MONGODB_URI=...
BRAVE_SEARCH_API_KEY=...   # recommended — enables SearchWeb

# .env.data-keys (data API keys — forwarded to background jobs only)
FRED_API_KEY=...           # free at fred.stlouisfed.org
FMP_API_KEY=...            # financialmodelingprep.com (250 calls/day free)
NEWSAPIORG_API_KEY=...     # newsapi.org (100 req/day free tier)

# 5. Build TypeScript
npm run build -w packages/agent-runtime-worker

# 6. Start the daemon
TEAM_CONFIG=$PWD/config/teams/equity-research.yaml npm run daemon -w packages/agent-runtime-worker
```

---

## Bootstrap phase

The bootstrap is a three-step guided conversation. The operator drives each transition.

---

### Step 1 — All-hands kick-off

Send this message to **all four agents simultaneously**:

```
TEAM_CONFIG=$PWD/config/teams/equity-research.yaml npm run cli:post -w packages/agent-runtime-worker -- \
  --to lead-analyst,economist,junior-analyst,data-scientist \
  "Welcome to the team.

You have been assembled as an equity research team with a specific mandate: track NVDA and
produce a daily brief each morning with a long/short recommendation and a running performance
record of the team's calls.

Take today to think carefully about what this mandate means for your role. Consider: what
sources you will need to monitor, what data you will need to collect, what infrastructure
needs to be built, and how you will coordinate with the rest of the team.

Tomorrow I will ask each of you individually to present your proposed setup. Please be ready
to describe: (1) your understanding of your role's scope, (2) the sources and data feeds you
intend to use, (3) any tools or infrastructure you need to build, and (4) what you will need
from other team members to do your job well."
```

Each agent processes the message, reflects, and updates their mental map. No output is
expected at this stage.

---

### Step 2 — Individual proposals

The next day, ask each agent individually for their proposal. Send one at a time:

```bash
# Lead Analyst
TEAM_CONFIG=$PWD/config/teams/equity-research.yaml npm run cli:post -w packages/agent-runtime-worker -- \
  --to lead-analyst "Please present your proposed setup for the team."

# Economist
TEAM_CONFIG=$PWD/config/teams/equity-research.yaml npm run cli:post -w packages/agent-runtime-worker -- \
  --to economist "Please present your proposed setup."

# Junior Analyst
TEAM_CONFIG=$PWD/config/teams/equity-research.yaml npm run cli:post -w packages/agent-runtime-worker -- \
  --to junior-analyst "Please present your proposed setup."

# Data Scientist
TEAM_CONFIG=$PWD/config/teams/equity-research.yaml npm run cli:post -w packages/agent-runtime-worker -- \
  --to data-scientist "Please present your proposed setup."
```

Each agent replies to the user. Review their proposals. Ask follow-up questions as needed
before proceeding.

---

### Step 2e — Data factory setup (Lin)

After reviewing proposals, ask Lin to bootstrap the data factory before the team begins daily operations:

```bash
TEAM_CONFIG=$PWD/config/teams/equity-research.yaml npm run cli:post -w packages/agent-runtime-worker -- \
  --to data-scientist \
  "Please set up the data factory now. Follow the instructions in your data-factory skill:
1. mkdir -p \$SHARED_DIR/data-factory
2. pip install requirements (magi-python3 handles the venv)
3. Copy sources.json and schedule.json from \$SKILL_DIR into \$SHARED_DIR/data-factory/
4. Run a first full refresh: \$SKILL_DIR/scripts/refresh.py \$SHARED_DIR
5. Register the daily 05:30 refresh using the schedule-task skill
6. PostMessage me (lead-analyst) with the catalog summary and any errors."
```

Wait for Lin to report back to Alex (lead-analyst) before proceeding to Step 3.

---

### Step 3 — Build and go

Once you are satisfied with the proposals and the data factory is running, tell the Lead to start:

```bash
TEAM_CONFIG=$PWD/config/teams/equity-research.yaml npm run cli:post -w packages/agent-runtime-worker -- \
  --to lead-analyst \
  "Proposals approved and data factory is online. Please coordinate the team to build any
remaining infrastructure. Once everything is in place, use the schedule-task skill to register
the 06:00 daily cycle and confirm to me when the team is ready to begin operations."
```

The Lead will:
1. Confirm the data factory catalog looks healthy
2. Task the Economist and Junior to set up their source lists using the data factory
3. Register the daily 06:00 schedule
4. Report back to you

Watch progress:
```bash
TEAM_CONFIG=$PWD/config/teams/equity-research.yaml npm run cli:tail -w packages/agent-runtime-worker
```

---

## Monitoring

The daemon starts a live dashboard automatically on port 4000:

```
http://localhost:4000
```

The dashboard shows:
- Real-time mailbox messages (coloured by agent, auto-scrolling)
- Per-agent token usage and cost (input, output, cache, LLM calls, $)
- Running mission total cost vs spending cap (if set)
- LLM call log (most recent first)
- **Stop daemon** button — graceful shutdown with confirmation prompt

To set a spending cap (budget pause triggers if exceeded):
```bash
MAX_COST_USD=5.00 TEAM_CONFIG=$PWD/config/teams/equity-research.yaml npm run daemon -w packages/agent-runtime-worker
```

To change the monitor port:
```bash
MONITOR_PORT=8080 TEAM_CONFIG=$PWD/config/teams/equity-research.yaml npm run daemon -w packages/agent-runtime-worker
```

To stop the daemon from another terminal (without the browser):
```bash
MISSION_ID=equity-research npm run cli:stop -w packages/agent-runtime-worker
```

---

## Daily operations

Once the daily cycle is running, the daemon delivers a `[task] Daily cycle — begin` message
to the Lead every weekday at 06:00. No operator action is required.

To read the latest brief:
```bash
cat missions/equity-research/shared/briefs/$(date +%Y-%m-%d).md
```

To check the performance tracker:
```bash
cat missions/equity-research/shared/tracker.csv
```

To inject an ad-hoc question or instruction:
```bash
TEAM_CONFIG=$PWD/config/teams/equity-research.yaml npm run cli:post -w packages/agent-runtime-worker -- \
  --to lead-analyst "What is your current view on NVDA given today's Fed announcement?"
```

---

## Data Factory

The data factory is a pre-fetched time-series store at `$SHARED_DIR/data-factory/` maintained by Lin (data-scientist). Analysts read from it instead of web-browsing on every cycle.

```bash
SHARED_DIR=missions/equity-research/shared
FACTORY=$SHARED_DIR/data-factory
DF_SCRIPTS=$SHARED_DIR/skills/_team/data-factory/scripts

# Check catalog status (ok / error / stale)
magi-python3 $DF_SCRIPTS/catalog.py list $FACTORY

# Manual refresh (runs all adapters + news digests + brief synthesis)
magi-python3 $DF_SCRIPTS/refresh.py $SHARED_DIR

# Read the latest NVDA news brief
cat $FACTORY/news/nvda_competitive_landscape/brief.md

# Read price data (newest rows last)
tail -5 $FACTORY/series/fmp/NVDA_daily_price.csv

# Add a new data source
# Edit $FACTORY/sources.json, add entry, then run refresh.py manually

# Check FMP budget (250 calls/day; factory guards at 200)
cat $FACTORY/.fmp_usage_$(date +%Y-%m-%d)

# View refresh log
tail -30 $FACTORY/refresh.log
```

If any catalog entry shows `status=error`, PostMessage the data-scientist to investigate:
```bash
TEAM_CONFIG=$PWD/config/teams/equity-research.yaml npm run cli:post -w packages/agent-runtime-worker -- \
  --to data-scientist "The data factory has errors — please check the catalog and refresh log and fix."
```

---

## Watching output

```bash
# Messages to/from the user only (default)
TEAM_CONFIG=$PWD/config/teams/equity-research.yaml npm run cli:tail -w packages/agent-runtime-worker

# Full inter-agent traffic (debugging)
TEAM_CONFIG=$PWD/config/teams/equity-research.yaml npm run cli:tail -w packages/agent-runtime-worker -- --all
```
