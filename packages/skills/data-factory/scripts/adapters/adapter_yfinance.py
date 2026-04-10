#!/usr/bin/env magi-python3
"""
adapter_yfinance.py — OHLCV price/volume data from Yahoo Finance.

PURPOSE
-------
Fetches daily open/high/low/close/volume bars for a stock or ETF ticker using
the yfinance library.  No API key required; Yahoo Finance is free and has no
documented rate limit for reasonable usage.

This is the primary fallback for NVDA price data when FMP is unavailable or
the daily budget is exhausted, and the only source for the SMH semiconductor
ETF (not available on FRED or FMP free tier).

OUTPUT FORMAT (CSV)
-------------------
  date,open,high,low,close,volume
  2025-04-01,825.50,831.20,820.10,828.40,32156700
  ...

Rows are ordered oldest-first (default yfinance behaviour after tz-strip).
"close" is the split/dividend-adjusted close (auto_adjust=True).

DEPENDENCY
----------
  pip3 install yfinance>=0.2

USAGE
-----
  python3 adapter_yfinance.py --discover
  python3 adapter_yfinance.py --fetch <output.csv> --series-id <id> \\
      --params '{"ticker":"NVDA"}'
  python3 adapter_yfinance.py --fetch <output.csv> --series-id <id> \\
      --params '{"ticker":"NVDA","period":"2y","interval":"1wk"}'
"""

import argparse
import json
import sys
from pathlib import Path


def discover() -> None:
    """
    Print adapter metadata as JSON to stdout.

    The catalog and agents call --discover to learn what series this adapter
    can produce without actually fetching any data.  The output lists the
    default series (the ones refresh.sh will fetch) and the full param schema
    so agents can request non-default tickers or periods if needed.
    """
    print(json.dumps({
        "adapter": "yfinance",
        "description": "Yahoo Finance OHLCV data. No API key required.",
        "series": [
            {
                "id": "yfinance/NVDA_daily",
                "params": {"ticker": "NVDA"},
                "description": "NVDA daily OHLCV (1 year, split-adjusted)",
            },
            {
                "id": "yfinance/SMH_daily",
                "params": {"ticker": "SMH"},
                "description": "VanEck Semiconductor ETF daily OHLCV",
            },
        ],
        "param_schema": {
            "ticker":   "Yahoo Finance ticker symbol (e.g. NVDA, SMH, AMD)",
            "period":   "Lookback period: 1d 5d 1mo 3mo 6mo 1y 2y 5y 10y ytd max (default: 1y)",
            "interval": "Bar interval: 1d 1wk 1mo (default: 1d)",
        },
    }, indent=2))


def fetch(output_path: str, series_id: str, params: dict) -> None:
    """
    Download OHLCV bars and write them to a CSV file.

    Imports yfinance lazily so the module can be imported (e.g. for --discover)
    even if yfinance is not installed.  Exits with code 1 on any error so the
    catalog marks the entry as "error" and continues with other sources.

    The timezone is stripped from the DatetimeIndex before writing so the CSV
    date column is a plain YYYY-MM-DD string (not "2025-04-01 00:00:00-04:00").
    """
    try:
        import yfinance as yf
    except ImportError:
        print("Error: yfinance not installed. Run: pip3 install yfinance", file=sys.stderr)
        sys.exit(1)

    ticker = params.get("ticker")
    if not ticker:
        print("Error: params must include 'ticker'", file=sys.stderr)
        sys.exit(1)

    period   = params.get("period", "1y")
    interval = params.get("interval", "1d")

    try:
        t = yf.Ticker(ticker)
        hist = t.history(period=period, interval=interval, auto_adjust=True)
    except Exception as exc:
        print(f"Error fetching {ticker}: {exc}", file=sys.stderr)
        sys.exit(1)

    if hist.empty:
        print(f"Error: no data returned for ticker '{ticker}'", file=sys.stderr)
        sys.exit(1)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    hist.index = hist.index.tz_localize(None)   # strip timezone for clean date strings
    hist = hist[["Open", "High", "Low", "Close", "Volume"]]
    hist.index.name = "date"
    hist.columns    = ["open", "high", "low", "close", "volume"]
    hist.to_csv(out)
    print(f"[yfinance] {ticker}: {len(hist)} rows → {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="yfinance OHLCV adapter")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--discover", action="store_true",
                       help="Print adapter metadata JSON and exit")
    group.add_argument("--fetch", metavar="OUTPUT_PATH",
                       help="Fetch data and write to this path")
    parser.add_argument("--series-id", default="",
                        help="Catalog series id (informational; not used by fetch logic)")
    parser.add_argument("--params", default="{}",
                        help="JSON object of fetch parameters")
    args = parser.parse_args()

    if args.discover:
        discover()
    else:
        params = json.loads(args.params)
        fetch(args.fetch, args.series_id, params)


if __name__ == "__main__":
    main()
