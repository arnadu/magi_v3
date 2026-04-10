---
name: data-factory-client
description: Read pre-fetched structured data from the data factory. Always check the catalog before using Research or SearchWeb — the data may already be available locally.
scope: platform
---

## Step 1: check what's available

```bash
FACTORY="$SHARED_DIR/data-factory"
SCRIPTS="$SHARED_DIR/skills/_platform/data-factory/scripts"
magi-python3 "$SCRIPTS/catalog.py" list "$FACTORY"
# Shows: id, type, status (ok/error/stale), fetched_at, path
```

## Step 2: read time-series data (CSV: date, value columns; newest row last)

```bash
# See all available series
ls "$FACTORY/series/"

# Read the last 3 rows of a series
tail -3 "$FACTORY/series/yfinance/SPY_daily.csv"   # date,open,high,low,close,volume
tail -3 "$FACTORY/series/fred/DFF.csv"             # date,value

# Head to see columns
head -1 "$FACTORY/series/yfinance/SPY_daily.csv"
```

## Step 3: read news digest and brief

```bash
# Latest news brief (synthesised by Research tool from digest)
cat "$FACTORY/news/<topic>/brief.md"

# Raw ranked digest (title, url, is_new flags)
cat "$FACTORY/news/<topic>/digest.json"
```

## Step 4: read document indexes

```bash
cat "$FACTORY/documents/<name>/index.json"
# Format: [{ "type": "...", "date": "...", "url": "https://..." }, ...]
# To read a specific document: use the Research tool or FetchUrl on the url field
```

## Fallback rule

If a series has `status=error` or `status=stale`, or a source you need isn't
in the catalog:

1. Use the Research tool to fetch it live
2. PostMessage the data factory operator to fix the broken source
