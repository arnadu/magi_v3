#!/usr/bin/env python3
"""
adapter_fred.py — Macro time-series from FRED (Federal Reserve Economic Data).

PURPOSE
-------
FRED is the St. Louis Fed's public database of over 800,000 economic time
series: interest rates, inflation, unemployment, yield curves, and more.
This adapter fetches individual series by their FRED series ID and writes
them as two-column CSVs (date, value) for use by Marco (Economist) and Sam.

Requires: FRED_API_KEY environment variable.
Free registration: https://fred.stlouisfed.org/docs/api/api_key.html
Rate limit: 120 requests/minute, which far exceeds daily refresh needs.

DEFAULT SERIES
--------------
  DFF       Federal funds effective rate (daily)
  T10Y2Y    10-year minus 2-year Treasury spread — yield curve (daily)
  CPIAUCSL  CPI all urban consumers, seasonally adjusted (monthly)
  UNRATE    Civilian unemployment rate (monthly)

These four cover the key macro dimensions that drive equity valuations:
monetary policy (DFF), recession signal (T10Y2Y), inflation (CPI), and
labour market (UNRATE).

OUTPUT FORMAT (CSV)
-------------------
  date,value
  2024-04-05,5.33
  2024-04-08,5.33
  ...

Rows are ordered oldest-first.  Missing-value periods ("." in FRED) are
filtered out so agents always get clean numeric data.

DEPENDENCY
----------
None (stdlib only: urllib.request, json).

USAGE
-----
  python3 adapter_fred.py --discover
  python3 adapter_fred.py --fetch <output.csv> --series-id fred/DFF \\
      --params '{"series_id":"DFF"}'
  python3 adapter_fred.py --fetch <output.csv> --series-id fred/T10Y2Y \\
      --params '{"series_id":"T10Y2Y","observation_start":"2020-01-01"}'
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


# FRED observations endpoint
FRED_API = "https://api.stlouisfed.org/fred/series/observations"


def discover() -> None:
    """
    Print adapter metadata as JSON to stdout.

    Lists the four default macro series and the parameter schema.  The
    observation_start param allows fetching a longer history if needed
    (e.g. for a multi-decade yield-curve chart).
    """
    print(json.dumps({
        "adapter": "fred",
        "description": "Federal Reserve Economic Data (FRED). Requires FRED_API_KEY.",
        "series": [
            {"id": "fred/DFF",      "params": {"series_id": "DFF"},      "description": "Fed funds rate (daily)"},
            {"id": "fred/T10Y2Y",   "params": {"series_id": "T10Y2Y"},   "description": "10Y-2Y yield curve spread (daily)"},
            {"id": "fred/CPIAUCSL", "params": {"series_id": "CPIAUCSL"}, "description": "CPI all urban consumers (monthly)"},
            {"id": "fred/UNRATE",   "params": {"series_id": "UNRATE"},   "description": "Unemployment rate (monthly)"},
        ],
        "param_schema": {
            "series_id":         "FRED series ID (e.g. DFF, T10Y2Y, CPIAUCSL, FEDFUNDS)",
            "observation_start": "Start date YYYY-MM-DD (default: 2 years ago)",
        },
    }, indent=2))


def fetch(output_path: str, series_id: str, params: dict) -> None:
    """
    Fetch a FRED series and write it to a date,value CSV.

    Reads the FRED_API_KEY from the environment — the key is never passed as
    a CLI argument to avoid it appearing in process lists or shell history.

    The default lookback window is 2 years (730 days), which is sufficient
    for daily and monthly series used in short-term equity analysis.  Agents
    can extend this via the observation_start param.

    FRED returns "." for missing observations (e.g. non-business days for
    daily series); these rows are filtered out before writing.
    """
    api_key = os.environ.get("FRED_API_KEY")
    if not api_key:
        print("Error: FRED_API_KEY environment variable not set", file=sys.stderr)
        sys.exit(1)

    fred_series = params.get("series_id")
    if not fred_series:
        print("Error: params must include 'series_id'", file=sys.stderr)
        sys.exit(1)

    # Default start date: 2 years ago (sufficient for current macro analysis)
    from datetime import date, timedelta
    start = params.get(
        "observation_start",
        (date.today() - timedelta(days=730)).isoformat(),
    )

    api_params = {
        "series_id":         fred_series,
        "api_key":           api_key,
        "file_type":         "json",
        "observation_start": start,
        "sort_order":        "asc",   # oldest-first to match yfinance/FMP conventions
    }

    url = f"{FRED_API}?{urllib.parse.urlencode(api_params)}"

    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            raw = json.loads(resp.read().decode())
    except urllib.error.URLError as exc:
        print(f"Error: FRED request failed: {exc}", file=sys.stderr)
        sys.exit(1)

    observations = raw.get("observations", [])
    # Filter out "." which FRED uses to represent missing/non-applicable values
    rows = [
        (o["date"], o["value"])
        for o in observations
        if o.get("value") != "."
    ]

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as f:
        f.write("date,value\n")
        for date_str, value in rows:
            f.write(f"{date_str},{value}\n")

    print(f"[fred] {fred_series}: {len(rows)} rows → {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="FRED macro series adapter")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--discover", action="store_true",
                       help="Print adapter metadata JSON and exit")
    group.add_argument("--fetch", metavar="OUTPUT_PATH",
                       help="Fetch series and write CSV to this path")
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
