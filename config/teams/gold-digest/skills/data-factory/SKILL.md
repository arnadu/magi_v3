---
name: data-factory-config
description: Gold Digest data factory configuration — sources.json and schedule.json for gold, macro, and news feeds. Use in conjunction with the platform data-factory skill.
scope: team
---

# Gold Digest Data Factory Configuration

This directory contains the pre-configured data sources for the Gold Digest mission.
Use these with the platform **data-factory** skill scripts.

## Quick start

```bash
FACTORY="$SHARED_DIR/data-factory"
PLATFORM_SCRIPTS="$SHARED_DIR/skills/_platform/data-factory/scripts"
TEAM_CONFIG="$SHARED_DIR/skills/_team/data-factory"

# 1. Bootstrap factory from pre-configured sources
mkdir -p "$FACTORY"
cp "$TEAM_CONFIG/sources.json" "$FACTORY/sources.json"
cp "$TEAM_CONFIG/schedule.json" "$FACTORY/schedule.json"

# 2. Submit the first refresh as a background job (NOT direct magi-python3 — direct calls have no data API keys)
bash "$SHARED_DIR/skills/_platform/run-background/scripts/submit-job.sh" \
  --script "$PLATFORM_SCRIPTS/refresh.py" \
  --args "$SHARED_DIR" \
  --agent "$AGENT_ID" \
  --notify-subject "First data refresh complete"

# 3. Check results
magi-python3 "$PLATFORM_SCRIPTS/catalog.py" list "$FACTORY"

# 4. Schedule daily refresh via run-background skill
bash "$SHARED_DIR/skills/_platform/run-background/scripts/schedule-job.sh" \
  --label "daily-refresh" \
  --cron "30 5 * * *" \
  --script "$PLATFORM_SCRIPTS/refresh.py" \
  --args "$SHARED_DIR" \
  --agent "$AGENT_ID" \
  --notify-subject "Daily refresh complete"
```

## Pre-configured sources

`sources.json` covers:
- **Prices**: GLD, GC=F (gold futures), DXY (dollar), TLT (bonds), TIP (TIPS), SPY, SLV (silver), GDX (gold miners) via yfinance
- **Macro**: FRED series — LBMA gold fix, 10Y TIPS real yield, 10Y breakeven inflation, Fed Funds Rate, yield curve (T10Y2Y), CPI, USD trade-weighted index
- **News**: gold market and Fed policy headlines via NewsAPI and GDELT

See `sources.json` for the full list and adapter parameters.
See the platform **data-factory** skill for adapter documentation and troubleshooting.
