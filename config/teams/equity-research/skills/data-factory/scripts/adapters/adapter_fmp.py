#!/usr/bin/env python3
"""
adapter_fmp.py - Fetch price/volume OHLCV and SEC filing index from FMP.

Requires: FMP_API_KEY environment variable.
Free tier: ~250 API calls/day. Budget guard enforced by catalog.py.

Usage:
  python3 adapter_fmp.py --discover
  python3 adapter_fmp.py --fetch <output> --series-id <id> --params '{"ticker":"NVDA","type":"daily"}'
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


FMP_API = "https://financialmodelingprep.com/api/v3"


def discover() -> None:
    print(json.dumps({
        "adapter": "fmp",
        "description": "Financial Modeling Prep. Requires FMP_API_KEY. Budget: 200 calls/day.",
        "series": [
            {"id": "fmp/NVDA_daily",   "params": {"ticker": "NVDA", "type": "daily"},       "description": "NVDA daily OHLCV"},
            {"id": "fmp/NVDA_filings", "params": {"ticker": "NVDA", "type": "sec_filings"}, "description": "NVDA SEC filing index"},
        ],
        "param_schema": {
            "ticker": "Stock ticker symbol",
            "type":   "daily | sec_filings",
        },
    }, indent=2))


def fetch(output_path: str, series_id: str, params: dict) -> None:
    api_key = os.environ.get("FMP_API_KEY")
    if not api_key:
        print("Error: FMP_API_KEY environment variable not set", file=sys.stderr)
        sys.exit(1)

    ticker = params.get("ticker")
    data_type = params.get("type", "daily")

    if not ticker:
        print("Error: params must include 'ticker'", file=sys.stderr)
        sys.exit(1)

    if data_type == "daily":
        _fetch_ohlcv(output_path, ticker, api_key)
    elif data_type == "sec_filings":
        _fetch_filings(output_path, ticker, api_key)
    else:
        print(f"Error: unknown type '{data_type}'", file=sys.stderr)
        sys.exit(1)


def _fetch_ohlcv(output_path: str, ticker: str, api_key: str) -> None:
    url = f"{FMP_API}/historical-price-full/{ticker}?apikey={api_key}"
    data = _get_json(url)
    historical = data.get("historical", [])

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as f:
        f.write("date,open,high,low,close,volume\n")
        for row in reversed(historical):  # oldest first
            f.write(f"{row['date']},{row['open']},{row['high']},"
                    f"{row['low']},{row['close']},{row['volume']}\n")

    print(f"[fmp] {ticker} OHLCV: {len(historical)} rows → {output_path}")


def _fetch_filings(output_path: str, ticker: str, api_key: str) -> None:
    url = f"{FMP_API}/sec_filings/{ticker}?type=&apikey={api_key}"
    data = _get_json(url)

    filings = [
        {
            "type":         f.get("type", ""),
            "date":         f.get("date", ""),
            "url":          f.get("finalLink") or f.get("link") or "",
            "description":  f.get("formType", ""),
        }
        for f in (data if isinstance(data, list) else [])
    ]

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(filings, indent=2))
    print(f"[fmp] {ticker} filings: {len(filings)} entries → {output_path}")


def _get_json(url: str) -> dict | list:
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.URLError as exc:
        print(f"Error: FMP request failed: {exc}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as exc:
        print(f"Error: invalid JSON from FMP: {exc}", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="FMP adapter")
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
