---
name: data-factory
description: Pre-fetched structured data store. Operator skill — set up data sources, run refreshes, schedule daily jobs. Covers time-series (price, macro, economic indicators), news digests, and document indexes.
scope: platform
---

# Data Factory

## Purpose

Maintains a persistent, local data store of pre-fetched time-series, news digests,
and document indexes under `$SHARED_DIR/data-factory/` (referred to as `$FACTORY`).

Rather than fetching web data on every agent turn, agents write structured sources
once, schedule a daily refresh, and then read from the factory. This reduces token
cost and latency significantly.

You are the **operator** of this factory. Other agents consume it via `data-factory-client`.

## Quick Start

```bash
FACTORY="$SHARED_DIR/data-factory"
SKILL_SCRIPTS="$SHARED_DIR/skills/_platform/data-factory/scripts"

# 1. Bootstrap factory directories
mkdir -p "$FACTORY"

# 2. Install Python dependencies (once per environment — already done if magi-python3 exists)
magi-python3 -m pip install -q -r "$SHARED_DIR/skills/_platform/data-factory/requirements.txt" 2>/dev/null || true

# 3. Write your sources.json (see format below)
# 4. Run the first refresh
magi-python3 "$SKILL_SCRIPTS/refresh.py" "$SHARED_DIR"

# 5. Check results
magi-python3 "$SKILL_SCRIPTS/catalog.py" list "$FACTORY"

# 6. Schedule daily refresh (optional — uses run-background skill)
# bash "$SHARED_DIR/skills/_platform/run-background/scripts/schedule-job.sh" \
#   --label "daily-refresh" \
#   --cron "30 5 * * *" \
#   --script "$SKILL_SCRIPTS/refresh.py" \
#   --args "$SHARED_DIR" \
#   --agent "$AGENT_ID" \
#   --notify-subject "Daily refresh complete"
```

## sources.json format

Write this to `$FACTORY/sources.json`:

```json
{
  "series": [
    {
      "id": "yfinance/SPY_daily",
      "adapter": "yfinance",
      "params": { "ticker": "SPY" },
      "schedule": "daily",
      "output": "series/yfinance/SPY_daily.csv"
    },
    {
      "id": "fred/DFF",
      "adapter": "fred",
      "params": { "series_id": "DFF" },
      "schedule": "daily",
      "output": "series/fred/DFF.csv"
    }
  ],
  "news": [
    {
      "id": "my-topic-news",
      "adapter": "newsapi",
      "params": { "q": "S&P 500 stock market", "language": "en" },
      "schedule": "daily",
      "output_dir": "news/my-topic-news"
    }
  ],
  "documents": []
}
```

## Supported adapters and required API keys

| Adapter | Data | Key required |
|---------|------|-------------|
| `yfinance` | OHLCV price/volume | none |
| `gdelt` | news headlines | none |
| `imf` | macro (annual) | none |
| `worldbank` | macro (annual) | none |
| `fred` | macro rates | `FRED_API_KEY` |
| `newsapi` | news headlines | `NEWSAPIORG_API_KEY` |
| `fmp` | price/volume, SEC filings | `FMP_API_KEY` |

API keys go in `.env.data-keys` (not `.env`).

## CSV format

All series CSVs: `date,<value-columns>` with newest row last.
- yfinance: `date,open,high,low,close,volume`
- fred: `date,value`

## Operator tasks

```bash
# Check status
magi-python3 "$SKILL_SCRIPTS/catalog.py" list "$FACTORY"

# Show one entry
magi-python3 "$SKILL_SCRIPTS/catalog.py" show "$FACTORY" "yfinance/SPY_daily"

# Manual re-run
magi-python3 "$SKILL_SCRIPTS/refresh.py" "$SHARED_DIR"

# Check FMP budget (if using FMP adapter)
cat "$FACTORY/.fmp_usage_$(date +%Y-%m-%d)"
```

## Refresh log

Each run appends a timestamped header to `$FACTORY/refresh.log`. Read it to diagnose failures:

```bash
tail -50 "$FACTORY/refresh.log"
```
