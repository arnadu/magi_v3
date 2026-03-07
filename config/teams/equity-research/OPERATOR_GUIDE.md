# Equity Research Team — Operator Guide

This guide describes how to start and run the NVDA equity research mission.

---

## Prerequisites

```bash
# 1. Pool users created (magi-w1..w4)
sudo scripts/setup-dev.sh

# 2. Playwright Chromium installed (needed for SEC EDGAR)
cd packages/agent-runtime-worker && npx playwright install chromium

# 3. Environment variables set in .env
ANTHROPIC_API_KEY=...
MONGODB_URI=...
BRAVE_SEARCH_API_KEY=...   # recommended — enables SearchWeb

# 4. Start the daemon
TEAM_CONFIG=config/teams/equity-research.yaml npm run daemon
```

---

## Bootstrap phase

The bootstrap is a three-step guided conversation. The operator drives each transition.

---

### Step 1 — All-hands kick-off

Send this message to **all four agents simultaneously**:

```
TEAM_CONFIG=config/teams/equity-research.yaml npm run cli:post -- \
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
TEAM_CONFIG=config/teams/equity-research.yaml npm run cli:post -- \
  --to lead-analyst "Please present your proposed setup for the team."

# Economist
TEAM_CONFIG=config/teams/equity-research.yaml npm run cli:post -- \
  --to economist "Please present your proposed setup."

# Junior Analyst
TEAM_CONFIG=config/teams/equity-research.yaml npm run cli:post -- \
  --to junior-analyst "Please present your proposed setup."

# Data Scientist
TEAM_CONFIG=config/teams/equity-research.yaml npm run cli:post -- \
  --to data-scientist "Please present your proposed setup."
```

Each agent replies to the user. Review their proposals. Ask follow-up questions as needed
before proceeding.

---

### Step 3 — Build and go

Once you are satisfied with the proposals, tell the Lead to start:

```bash
TEAM_CONFIG=config/teams/equity-research.yaml npm run cli:post -- \
  --to lead-analyst \
  "Proposals approved. Please coordinate the team to build the infrastructure you described.
Once everything is in place, use the schedule-task skill to register the 06:00 daily cycle
and confirm to me when the team is ready to begin operations."
```

The Lead will:
1. Task the Economist and Junior to set up their source lists and send data requirements to Lin
2. Task the Data Scientist to build collection scripts and initialise the tracker
3. Register the daily 06:00 schedule
4. Report back to you

Watch progress:
```bash
TEAM_CONFIG=config/teams/equity-research.yaml npm run cli:tail
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

To set a spending cap (daemon aborts if exceeded):
```bash
MAX_COST_USD=5.00 TEAM_CONFIG=... npm run daemon
```

To change the monitor port:
```bash
MONITOR_PORT=8080 TEAM_CONFIG=... npm run daemon
```

To stop the daemon from another terminal (without the browser):
```bash
MISSION_ID=equity-research npm run cli:stop
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
TEAM_CONFIG=config/teams/equity-research.yaml npm run cli:post -- \
  --to lead-analyst "What is your current view on NVDA given today's Fed announcement?"
```

---

## Watching output

```bash
# Messages to/from the user only (default)
TEAM_CONFIG=config/teams/equity-research.yaml npm run cli:tail

# Full inter-agent traffic (debugging)
TEAM_CONFIG=config/teams/equity-research.yaml npm run cli:tail -- --all
```
