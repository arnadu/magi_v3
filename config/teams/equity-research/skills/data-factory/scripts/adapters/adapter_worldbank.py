#!/usr/bin/env python3
"""
adapter_worldbank.py - Fetch macro indicators from the World Bank API.

No API key required. Uses the World Bank Indicators REST API v2.

Usage:
  python3 adapter_worldbank.py --discover
  python3 adapter_worldbank.py --fetch <output.csv> --series-id <id> \
    --params '{"indicator":"NY.GDP.MKTP.KD.ZG","country":"US"}'
"""

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


WB_API = "https://api.worldbank.org/v2"


def discover() -> None:
    print(json.dumps({
        "adapter": "worldbank",
        "description": "World Bank Indicators API. No API key required.",
        "series": [
            {
                "id": "worldbank/US_GDP_GROWTH",
                "params": {"indicator": "NY.GDP.MKTP.KD.ZG", "country": "US"},
                "description": "US GDP growth rate (annual %)",
            },
            {
                "id": "worldbank/US_INFLATION",
                "params": {"indicator": "FP.CPI.TOTL.ZG", "country": "US"},
                "description": "US inflation (consumer prices, annual %)",
            },
            {
                "id": "worldbank/CN_GDP_GROWTH",
                "params": {"indicator": "NY.GDP.MKTP.KD.ZG", "country": "CN"},
                "description": "China GDP growth rate (annual %)",
            },
        ],
        "param_schema": {
            "indicator": "World Bank indicator code (e.g. NY.GDP.MKTP.KD.ZG, FP.CPI.TOTL.ZG)",
            "country":   "ISO2 country code (e.g. US, CN, JP)",
            "mrv":       "Most recent N values (default: 10)",
        },
    }, indent=2))


def fetch(output_path: str, series_id: str, params: dict) -> None:
    indicator = params.get("indicator")
    country = params.get("country", "US")
    mrv = int(params.get("mrv", 10))

    if not indicator:
        print("Error: params must include 'indicator'", file=sys.stderr)
        sys.exit(1)

    # GET /country/{country}/indicator/{indicator}?format=json&mrv=N
    api_params = {
        "format": "json",
        "mrv": str(mrv),
        "per_page": str(mrv),
    }
    url = (
        f"{WB_API}/country/{urllib.parse.quote(country)}"
        f"/indicator/{urllib.parse.quote(indicator)}"
        f"?{urllib.parse.urlencode(api_params)}"
    )

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "MAGI-DataFactory/1.0"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode())
    except urllib.error.URLError as exc:
        print(f"Error: World Bank request failed: {exc}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as exc:
        print(f"Error: invalid JSON from World Bank: {exc}", file=sys.stderr)
        sys.exit(1)

    # Response shape: [metadata, [{ "date": "2023", "value": 2.5, ... }, ...]]
    if not isinstance(raw, list) or len(raw) < 2:
        print(f"Error: unexpected World Bank response format", file=sys.stderr)
        sys.exit(1)

    data_records = raw[1] or []
    rows = [
        (r["date"], r["value"])
        for r in data_records
        if r.get("value") is not None
    ]
    rows.sort(key=lambda x: x[0])  # oldest first

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as f:
        f.write("date,value\n")
        for date_str, value in rows:
            f.write(f"{date_str},{value}\n")

    print(f"[worldbank] {indicator}/{country}: {len(rows)} rows → {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="World Bank adapter")
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
