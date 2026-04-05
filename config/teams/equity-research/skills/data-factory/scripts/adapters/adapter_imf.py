#!/usr/bin/env python3
"""
adapter_imf.py - Fetch macro series from the IMF Data API.

No API key required. Uses the IMF JSON RESTful API v2.

Usage:
  python3 adapter_imf.py --discover
  python3 adapter_imf.py --fetch <output.csv> --series-id <id> \
    --params '{"database":"IFS","series":"M.US.PCPI_IX"}'
"""

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


IMF_API = "https://www.imf.org/external/datamapper/api/v1"


def discover() -> None:
    print(json.dumps({
        "adapter": "imf",
        "description": "IMF DataMapper API. No API key required.",
        "series": [
            {
                "id": "imf/US_CPI",
                "params": {"indicator": "PCPI_IX", "country": "US"},
                "description": "US Consumer Price Index (IMF)",
            },
            {
                "id": "imf/US_GDP_GROWTH",
                "params": {"indicator": "NGDP_RPCH", "country": "US"},
                "description": "US Real GDP growth rate (annual %)",
            },
        ],
        "param_schema": {
            "indicator": "IMF indicator code (e.g. PCPI_IX, NGDP_RPCH, LUR)",
            "country":   "ISO2 country code (e.g. US, CN, JP)",
        },
    }, indent=2))


def fetch(output_path: str, series_id: str, params: dict) -> None:
    indicator = params.get("indicator")
    country = params.get("country", "US")

    if not indicator:
        print("Error: params must include 'indicator'", file=sys.stderr)
        sys.exit(1)

    # GET /indicator/{indicator}/{country}
    url = f"{IMF_API}/indicator/{urllib.parse.quote(indicator)}/{urllib.parse.quote(country)}"

    try:
        req = urllib.request.Request(
            url,
            headers={"Accept": "application/json", "User-Agent": "MAGI-DataFactory/1.0"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode())
    except urllib.error.URLError as exc:
        print(f"Error: IMF request failed: {exc}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as exc:
        print(f"Error: invalid JSON from IMF: {exc}", file=sys.stderr)
        sys.exit(1)

    # Response shape: { "values": { "INDICATOR": { "COUNTRY": { "YEAR": value } } } }
    values = raw.get("values", {})
    country_data = (
        values.get(indicator, {})
              .get(country, {})
    )

    if not country_data:
        print(f"Error: no data for indicator={indicator} country={country}", file=sys.stderr)
        sys.exit(1)

    rows = sorted(country_data.items())  # [(year_str, value), ...]

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as f:
        f.write("date,value\n")
        for year, value in rows:
            if value is not None:
                f.write(f"{year},{value}\n")

    print(f"[imf] {indicator}/{country}: {len(rows)} rows → {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="IMF adapter")
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
