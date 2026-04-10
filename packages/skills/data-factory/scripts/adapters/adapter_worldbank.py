#!/usr/bin/env magi-python3
"""
adapter_worldbank.py — Macro indicators from the World Bank Indicators API.

PURPOSE
-------
The World Bank publishes hundreds of development and economic indicators
through its open REST API.  This adapter fetches per-country time series
such as GDP growth, inflation, population, and trade statistics.

Like the IMF adapter, World Bank data is annual and updated with a significant
lag.  It provides structural macro context (multi-year trends, cross-country
comparisons) rather than tactical trading signals.

The primary use case is to give Marco (Economist) a second authoritative
source for GDP and inflation trends, with broader country coverage than IMF
and a longer history for some series.

No API key required.  The World Bank Indicators API is a public, free service.

OUTPUT FORMAT (CSV)
-------------------
  date,value
  2014,2.5
  2015,2.9
  ...

The "date" column is a 4-digit year (annual series).  Rows are sorted
oldest-first.  Years with null values are omitted.

DEPENDENCY
----------
None (stdlib only: urllib.request, json).

API REFERENCE
-------------
  GET https://api.worldbank.org/v2/country/{country}/indicator/{indicator}
        ?format=json&mrv={N}&per_page={N}
  Response: [ {metadata}, [{date, value, ...}, ...] ]

USAGE
-----
  python3 adapter_worldbank.py --discover
  python3 adapter_worldbank.py --fetch <output.csv> --series-id worldbank/US_GDP_GROWTH \\
      --params '{"indicator":"NY.GDP.MKTP.KD.ZG","country":"US"}'
  python3 adapter_worldbank.py --fetch <output.csv> --series-id worldbank/CN_GDP_GROWTH \\
      --params '{"indicator":"NY.GDP.MKTP.KD.ZG","country":"CN","mrv":20}'
"""

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


# World Bank Indicators API v2 base URL
WB_API = "https://api.worldbank.org/v2"


def discover() -> None:
    """
    Print adapter metadata as JSON to stdout.

    Lists three default series: US GDP growth, US inflation, and China GDP
    growth.  These three together let Marco assess whether a US slowdown is
    being offset by Chinese demand — a key consideration for semiconductor
    cycle analysis.
    """
    print(json.dumps({
        "adapter": "worldbank",
        "description": "World Bank Indicators API. No API key required. Annual frequency.",
        "series": [
            {
                "id": "worldbank/US_GDP_GROWTH",
                "params": {"indicator": "NY.GDP.MKTP.KD.ZG", "country": "US"},
                "description": "US GDP growth rate, annual % (World Bank)",
            },
            {
                "id": "worldbank/US_INFLATION",
                "params": {"indicator": "FP.CPI.TOTL.ZG", "country": "US"},
                "description": "US inflation (consumer prices, annual %)",
            },
            {
                "id": "worldbank/CN_GDP_GROWTH",
                "params": {"indicator": "NY.GDP.MKTP.KD.ZG", "country": "CN"},
                "description": "China GDP growth rate, annual %",
            },
        ],
        "param_schema": {
            "indicator": "World Bank indicator code (e.g. NY.GDP.MKTP.KD.ZG, FP.CPI.TOTL.ZG)",
            "country":   "ISO2 country code (e.g. US, CN, JP, DE)",
            "mrv":       "Most recent N values to fetch (default: 10, i.e. last 10 years)",
        },
    }, indent=2))


def fetch(output_path: str, series_id: str, params: dict) -> None:
    """
    Fetch a World Bank annual series and write it to a date,value CSV.

    The "mrv" (most recent values) parameter limits the response to the last N
    years, which avoids fetching decades of data for a simple trend check.
    Default is 10 years.

    The World Bank API returns records newest-first; we sort to oldest-first
    to match the convention used by yfinance, FRED, and the FMP adapter.
    Records with null values are omitted.

    The response format is a two-element array:
        [ {metadata dict}, [{date, value, country, ...}, ...] ]
    The second element is the data array.
    """
    indicator = params.get("indicator")
    country   = params.get("country", "US")
    mrv       = int(params.get("mrv", 10))

    if not indicator:
        print("Error: params must include 'indicator'", file=sys.stderr)
        sys.exit(1)

    api_params = {
        "format":   "json",
        "mrv":      str(mrv),
        "per_page": str(mrv),   # must match mrv to avoid pagination
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

    # The API wraps data in a two-element array: [metadata, records]
    if not isinstance(raw, list) or len(raw) < 2:
        print("Error: unexpected World Bank response format", file=sys.stderr)
        sys.exit(1)

    data_records = raw[1] or []
    rows = [
        (r["date"], r["value"])
        for r in data_records
        if r.get("value") is not None   # skip null entries
    ]
    rows.sort(key=lambda x: x[0])   # sort by year string, oldest-first

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as f:
        f.write("date,value\n")
        for date_str, value in rows:
            f.write(f"{date_str},{value}\n")

    print(f"[worldbank] {indicator}/{country}: {len(rows)} rows → {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="World Bank Indicators macro adapter")
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
