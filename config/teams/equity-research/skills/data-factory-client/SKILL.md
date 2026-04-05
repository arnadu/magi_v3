---
name: data-factory-client
description: |
  Read pre-fetched NVDA equity data. Always check catalog before using Research or SearchWeb.
  Covers: OHLCV price/volume, macro rates (FRED), news briefs, SEC filing index.
scope: team
---

## Step 1: check what's available

```bash
FACTORY="$SHARED_DIR/data-factory"
python3 "$SHARED_DIR/skills/_team/data-factory/scripts/catalog.py" list "$FACTORY"
# Shows: id, type, status (ok/error/stale), fetched_at, path
```

If `status=error` or `status=stale` for a series you need: use Research as fallback
and PostMessage data-scientist to flag the broken source.

## Time-series (CSV: newest row last)

```bash
# NVDA price/volume: date,open,high,low,close,volume
tail -5 "$FACTORY/series/yfinance/NVDA_daily.csv"

# Semiconductor ETF (benchmark): date,open,high,low,close,volume
tail -5 "$FACTORY/series/yfinance/SMH_daily.csv"

# Fed funds rate: date,value
tail -3 "$FACTORY/series/fred/DFF.csv"

# Yield curve (10Y-2Y spread): date,value
tail -3 "$FACTORY/series/fred/T10Y2Y.csv"

# Discover all available series
ls "$FACTORY/series/"
```

## News brief (updated daily ~05:30)

```bash
# Read the synthesized brief
cat "$FACTORY/news/nvda_competitive_landscape/brief.md"

# See what's new today (is_new=true items)
bash "$SHARED_DIR/skills/_team/data-factory-client/scripts/read-digest.sh" \
  nvda_competitive_landscape
```

## SEC filings index (updated weekly)

```bash
cat "$FACTORY/documents/NVDA/filings/index.json"
# Format: [{"type":"10-K","date":"2025-01-15","url":"https://..."}]
```

To read a specific filing (no local copies stored):
```
Use FetchUrl on the url field from the index.
```

## Fallback rule

If a series is missing or `status=error`:
1. Use `magi-tool research` for live data
2. PostMessage data-scientist: `"Series <id> is stale/missing, please investigate"`
