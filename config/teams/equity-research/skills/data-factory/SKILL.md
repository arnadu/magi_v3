---
name: data-factory
description: |
  Pre-fetched data store for NVDA equity research. You (Lin) are the operator.
  Run refresh.py daily before writing briefs. Manage sources.json and schedule.json.
  Covers: OHLCV price/volume, macro rates, news digests + briefs, SEC filing index.
scope: team
---

## Quick Start (first run)

```bash
FACTORY="$SHARED_DIR/data-factory"
SKILL_DIR="$(dirname "$0")/.."   # adjust to actual skill path

mkdir -p "$FACTORY"
pip3 install -r "$SKILL_DIR/requirements.txt" --quiet

# Copy config files (edit sources.json to add/remove sources)
cp "$SKILL_DIR/sources.json" "$FACTORY/sources.json"
cp "$SKILL_DIR/schedule.json" "$FACTORY/schedule.json"

# First full refresh (5-10 min depending on API availability)
python3 "$SKILL_DIR/scripts/refresh.py" "$SHARED_DIR"

# Verify
python3 "$SKILL_DIR/scripts/catalog.py" list "$FACTORY"
```

Then register the daily schedule:
```bash
bash "$SHARED_DIR/skills/_platform/run-background/scripts/schedule-job.sh" \
  --cron "30 5 * * *" \
  --script "$SKILL_DIR/scripts/refresh.py" \
  --args "$SHARED_DIR" \
  --agent data-scientist \
  --notify-subject "Daily data factory refresh complete"
```

PostMessage lead-analyst with the catalog summary and any errors.

## Operator tasks

| Task | Command |
|------|---------|
| Check status | `python3 $SKILL_DIR/scripts/catalog.py list $FACTORY` |
| Manual refresh | `python3 $SKILL_DIR/scripts/refresh.py $SHARED_DIR` |
| Add a series | Edit `$FACTORY/sources.json`, add entry, run refresh |
| Remove a series | Edit `$FACTORY/sources.json`, remove entry (data files remain) |
| Check FMP budget | `cat $FACTORY/.fmp_usage_$(date +%Y-%m-%d)` (must be < 200) |
| View refresh log | `tail -50 $FACTORY/refresh.log` |

## API keys required

Set in `.env` (never in agent scripts):
- `FMP_API_KEY` — price/volume, SEC filings (financialmodelingprep.com)
- `FRED_API_KEY` — macro rates, free at fred.stlouisfed.org
- `NEWSAPIORG_API_KEY` — news headlines, free tier: 100 req/day (newsapi.org)

Sources without API keys: `yfinance`, `gdelt`, `imf`, `worldbank`

## Data layout

```
$FACTORY/
  catalog.json             status of all series
  refresh.log              append-only refresh history
  .fmp_usage_YYYY-MM-DD    daily FMP call counter
  series/
    yfinance/NVDA_daily.csv   date,open,high,low,close,volume
    fred/DFF.csv               date,value
    fred/T10Y2Y.csv            date,value
  news/
    nvda_competitive_landscape/
      raw.json             adapter output
      digest.json          de-duped, ranked, with is_new flags
      brief.md             LLM-synthesized brief (updated by refresh)
  documents/
    NVDA/filings/index.json  [{type, date, url}] — no local copies
```
