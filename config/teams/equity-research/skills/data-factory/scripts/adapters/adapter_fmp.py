#!/usr/bin/env python3
"""
adapter_fmp.py — Price/volume OHLCV and SEC filing index from Financial Modeling Prep.

PURPOSE
-------
FMP (financialmodelingprep.com) provides institutional-quality financial data
via a REST API.  This adapter uses two FMP endpoints:

  1. historical-price-full — daily OHLCV bars going back several years.
     This is richer than yfinance for adjusted prices and better suited to
     backtesting, but costs API calls (yfinance is the free fallback).

  2. sec_filings — index of SEC filings for a ticker: 10-K, 10-Q, 8-K, etc.
     Provides filing date, type, and a direct URL to the full document on
     SEC EDGAR.  Agents call FetchUrl on-demand for filings they want to read;
     we do NOT download or cache the documents themselves.

Requires: FMP_API_KEY environment variable.
Free tier: ~250 API calls/day.  The catalog budget guard (DEFAULT_FMP_BUDGET=200)
reserves 50 calls for ad-hoc agent use.

OUTPUT FORMAT
-------------
Type "daily" (CSV):
  date,open,high,low,close,volume
  2023-01-03,143.97,144.22,141.29,143.96,67523100
  ...   (rows ordered oldest-first)

Type "sec_filings" (JSON):
  [
    {
      "type":        "10-K",
      "date":        "2025-01-15",
      "url":         "https://www.sec.gov/Archives/edgar/...",
      "description": "10-K"     # form type repeated for readability
    },
    ...
  ]

DEPENDENCY
----------
None (stdlib only: urllib.request, json).

USAGE
-----
  python3 adapter_fmp.py --discover
  python3 adapter_fmp.py --fetch <output.csv> --series-id fmp/NVDA_daily \\
      --params '{"ticker":"NVDA","type":"daily"}'
  python3 adapter_fmp.py --fetch <output.json> --series-id fmp/NVDA_filings \\
      --params '{"ticker":"NVDA","type":"sec_filings"}'
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


# FMP v3 base URL
FMP_API = "https://financialmodelingprep.com/api/v3"


def discover() -> None:
    """
    Print adapter metadata as JSON to stdout.

    Lists both default series (NVDA price and NVDA filing index) and the
    two supported data types so the catalog can route fetch requests correctly.
    """
    print(json.dumps({
        "adapter": "fmp",
        "description": "Financial Modeling Prep. Requires FMP_API_KEY. Budget: 200 calls/day.",
        "series": [
            {
                "id": "fmp/NVDA_daily",
                "params": {"ticker": "NVDA", "type": "daily"},
                "description": "NVDA daily OHLCV (full history)",
            },
            {
                "id": "fmp/NVDA_filings",
                "params": {"ticker": "NVDA", "type": "sec_filings"},
                "description": "NVDA SEC filing index (type, date, URL)",
            },
        ],
        "param_schema": {
            "ticker": "Stock ticker symbol (e.g. NVDA, AMD, INTC)",
            "type":   "'daily' for OHLCV CSV | 'sec_filings' for JSON index",
        },
    }, indent=2))


def fetch(output_path: str, series_id: str, params: dict) -> None:
    """
    Dispatch to the correct fetch function based on the 'type' param.

    Reads FMP_API_KEY from the environment.  Exits with code 1 if the key
    is missing or the 'type' param is unrecognised, so the catalog can mark
    the entry as "error" and move on.
    """
    api_key = os.environ.get("FMP_API_KEY")
    if not api_key:
        print("Error: FMP_API_KEY environment variable not set", file=sys.stderr)
        sys.exit(1)

    ticker    = params.get("ticker")
    data_type = params.get("type", "daily")

    if not ticker:
        print("Error: params must include 'ticker'", file=sys.stderr)
        sys.exit(1)

    if data_type == "daily":
        _fetch_ohlcv(output_path, ticker, api_key)
    elif data_type == "sec_filings":
        _fetch_filings(output_path, ticker, api_key)
    else:
        print(f"Error: unknown type '{data_type}' (expected 'daily' or 'sec_filings')",
              file=sys.stderr)
        sys.exit(1)


def _fetch_ohlcv(output_path: str, ticker: str, api_key: str) -> None:
    """
    Fetch the full historical price series for a ticker and write a CSV.

    FMP returns the most recent data first; we reverse to oldest-first to
    match the yfinance/FRED convention so agents can always use `tail` to
    get the latest rows.

    Columns written: date, open, high, low, close, volume
    All price values are as returned by FMP (split-adjusted on free tier).
    """
    url = f"{FMP_API}/historical-price-full/{ticker}?apikey={api_key}"
    data = _get_json(url)
    historical = data.get("historical", [])

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as f:
        f.write("date,open,high,low,close,volume\n")
        for row in reversed(historical):   # FMP returns newest-first; reverse to oldest-first
            f.write(
                f"{row['date']},{row['open']},{row['high']},"
                f"{row['low']},{row['close']},{row['volume']}\n"
            )

    print(f"[fmp] {ticker} OHLCV: {len(historical)} rows → {output_path}")


def _fetch_filings(output_path: str, ticker: str, api_key: str) -> None:
    """
    Fetch the SEC filing index for a ticker and write a JSON file.

    FMP returns all filing types (10-K, 10-Q, 8-K, DEF 14A, etc.) sorted
    newest-first.  We normalise to a minimal schema: type, date, url.
    The "url" field points directly to the final filed document on SEC EDGAR
    so agents can pass it to FetchUrl without any further lookup.

    We deliberately do NOT download or cache the filings themselves — they can
    be very large (10-K filings are often 200–400 pages).  Agents use the
    index to identify the filing they need and then call FetchUrl on-demand.
    """
    url = f"{FMP_API}/sec_filings/{ticker}?type=&apikey={api_key}"
    data = _get_json(url)

    filings = [
        {
            "type":        f.get("type", ""),
            "date":        f.get("date", ""),
            "url":         f.get("finalLink") or f.get("link") or "",
            "description": f.get("formType", ""),
        }
        for f in (data if isinstance(data, list) else [])
    ]

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(filings, indent=2))
    print(f"[fmp] {ticker} filings: {len(filings)} entries → {output_path}")


def _get_json(url: str) -> dict | list:
    """
    Perform a GET request to a FMP URL and return the parsed JSON body.

    Exits with code 1 on network errors or invalid JSON so the catalog can
    record the failure without crashing the entire refresh run.
    """
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
    parser = argparse.ArgumentParser(description="FMP price/filings adapter")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--discover", action="store_true",
                       help="Print adapter metadata JSON and exit")
    group.add_argument("--fetch", metavar="OUTPUT_PATH",
                       help="Fetch data and write to this path")
    parser.add_argument("--series-id", default="",
                        help="Catalog series id (informational)")
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
