#!/usr/bin/env python3
"""
adapter_yfinance.py - Fetch OHLCV price/volume data from Yahoo Finance.

No API key required.

Usage:
  python3 adapter_yfinance.py --discover
  python3 adapter_yfinance.py --fetch <output.csv> --series-id <id> --params '{"ticker":"NVDA"}'
"""

import argparse
import json
import sys
from pathlib import Path


def discover() -> None:
    print(json.dumps({
        "adapter": "yfinance",
        "description": "Yahoo Finance OHLCV data. No API key required.",
        "series": [
            {
                "id": "yfinance/NVDA_daily",
                "params": {"ticker": "NVDA"},
                "description": "NVDA daily OHLCV",
            },
            {
                "id": "yfinance/SMH_daily",
                "params": {"ticker": "SMH"},
                "description": "VanEck Semiconductor ETF daily OHLCV",
            },
        ],
        "param_schema": {
            "ticker": "Yahoo Finance ticker symbol (e.g. NVDA, SMH)",
        },
    }, indent=2))


def fetch(output_path: str, series_id: str, params: dict) -> None:
    try:
        import yfinance as yf
    except ImportError:
        print("Error: yfinance not installed. Run: pip3 install yfinance", file=sys.stderr)
        sys.exit(1)

    ticker = params.get("ticker")
    if not ticker:
        print("Error: params must include 'ticker'", file=sys.stderr)
        sys.exit(1)

    period = params.get("period", "1y")
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

    hist.index = hist.index.tz_localize(None)  # remove timezone for clean CSV dates
    hist = hist[["Open", "High", "Low", "Close", "Volume"]]
    hist.index.name = "date"
    hist.columns = ["open", "high", "low", "close", "volume"]
    hist.to_csv(out)
    print(f"[yfinance] {ticker}: {len(hist)} rows → {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="yfinance adapter")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--discover", action="store_true")
    group.add_argument("--fetch", metavar="OUTPUT_PATH")
    parser.add_argument("--series-id", default="")
    parser.add_argument("--params", default="{}")
    args = parser.parse_args()

    if args.discover:
        discover()
    else:
        params = json.loads(args.params)
        fetch(args.fetch, args.series_id, params)


if __name__ == "__main__":
    main()
