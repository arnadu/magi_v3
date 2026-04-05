#!/usr/bin/env python3
"""
adapter_fred.py - Fetch macro series from FRED (Federal Reserve Economic Data).

Requires: FRED_API_KEY environment variable.
Free registration at: https://fred.stlouisfed.org/docs/api/api_key.html

Usage:
  python3 adapter_fred.py --discover
  python3 adapter_fred.py --fetch <output.csv> --series-id <id> --params '{"series_id":"DFF"}'
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


FRED_API = "https://api.stlouisfed.org/fred/series/observations"


def discover() -> None:
    print(json.dumps({
        "adapter": "fred",
        "description": "Federal Reserve Economic Data. Requires FRED_API_KEY.",
        "series": [
            {"id": "fred/DFF",      "params": {"series_id": "DFF"},      "description": "Fed funds rate (daily)"},
            {"id": "fred/T10Y2Y",   "params": {"series_id": "T10Y2Y"},   "description": "10Y-2Y yield curve spread (daily)"},
            {"id": "fred/CPIAUCSL", "params": {"series_id": "CPIAUCSL"}, "description": "CPI all urban consumers (monthly)"},
            {"id": "fred/UNRATE",   "params": {"series_id": "UNRATE"},   "description": "Unemployment rate (monthly)"},
        ],
        "param_schema": {
            "series_id":    "FRED series ID (e.g. DFF, T10Y2Y, CPIAUCSL)",
            "observation_start": "Start date YYYY-MM-DD (default: 2 years ago)",
        },
    }, indent=2))


def fetch(output_path: str, series_id: str, params: dict) -> None:
    api_key = os.environ.get("FRED_API_KEY")
    if not api_key:
        print("Error: FRED_API_KEY environment variable not set", file=sys.stderr)
        sys.exit(1)

    fred_series = params.get("series_id")
    if not fred_series:
        print("Error: params must include 'series_id'", file=sys.stderr)
        sys.exit(1)

    from datetime import date, timedelta
    start = params.get("observation_start",
                       (date.today() - timedelta(days=730)).isoformat())

    api_params = {
        "series_id":         fred_series,
        "api_key":           api_key,
        "file_type":         "json",
        "observation_start": start,
        "sort_order":        "asc",
    }

    url = f"{FRED_API}?{urllib.parse.urlencode(api_params)}"

    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            raw = json.loads(resp.read().decode())
    except urllib.error.URLError as exc:
        print(f"Error: FRED request failed: {exc}", file=sys.stderr)
        sys.exit(1)

    observations = raw.get("observations", [])
    # Filter out "." (missing values)
    rows = [(o["date"], o["value"]) for o in observations if o.get("value") != "."]

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as f:
        f.write("date,value\n")
        for date_str, value in rows:
            f.write(f"{date_str},{value}\n")

    print(f"[fred] {fred_series}: {len(rows)} rows → {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="FRED adapter")
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
