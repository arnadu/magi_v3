#!/usr/bin/env magi-python3
"""
adapter_imf.py — Macro indicators from the IMF DataMapper API.

PURPOSE
-------
The International Monetary Fund publishes cross-country economic indicators
through its DataMapper API.  This adapter fetches per-country time series
such as CPI, GDP growth, and current account balance.

Unlike FRED (which covers US data only), IMF data allows multi-country
comparison — useful for Marco (Economist) when assessing global demand for
AI infrastructure and semiconductor supply chains.

No API key required.  The IMF DataMapper is a public, free endpoint.

NOTE: IMF data is annual (calendar-year frequency) and updated with a lag of
several months.  It is not suitable for real-time monitoring; it provides
structural macro context (multi-year trends) rather than tactical signals.

OUTPUT FORMAT (CSV)
-------------------
  date,value
  2020,2.5
  2021,4.7
  2022,8.0
  ...

The "date" column is a 4-digit year string (not a full ISO date) because IMF
series are annual.  Agents reading this data should handle both YYYY and
YYYY-MM-DD date columns.

DEPENDENCY
----------
None (stdlib only: urllib.request, json).

API REFERENCE
-------------
  GET https://www.imf.org/external/datamapper/api/v1/indicator/{INDICATOR}/{COUNTRY}
  Response: { "values": { "INDICATOR": { "COUNTRY": { "2020": 2.5, "2021": 4.7, ... } } } }

USAGE
-----
  python3 adapter_imf.py --discover
  python3 adapter_imf.py --fetch <output.csv> --series-id imf/US_CPI \\
      --params '{"indicator":"PCPI_IX","country":"US"}'
"""

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


# IMF DataMapper API base URL
IMF_API = "https://www.imf.org/external/datamapper/api/v1"


def discover() -> None:
    """
    Print adapter metadata as JSON to stdout.

    Lists two default series (US CPI and US real GDP growth) which provide
    structural macro context complementing the higher-frequency FRED data.
    Agents can fetch any indicator/country combination supported by the IMF
    DataMapper by overriding the params.
    """
    print(json.dumps({
        "adapter": "imf",
        "description": "IMF DataMapper API. No API key required. Annual frequency.",
        "series": [
            {
                "id": "imf/US_CPI",
                "params": {"indicator": "PCPI_IX", "country": "US"},
                "description": "US Consumer Price Index, 2017=100 (IMF, annual)",
            },
            {
                "id": "imf/US_GDP_GROWTH",
                "params": {"indicator": "NGDP_RPCH", "country": "US"},
                "description": "US Real GDP growth rate, annual % (IMF)",
            },
        ],
        "param_schema": {
            "indicator": "IMF indicator code (e.g. PCPI_IX=CPI, NGDP_RPCH=GDP growth, LUR=unemployment)",
            "country":   "ISO2 country code (e.g. US, CN, DE, JP)",
        },
    }, indent=2))


def fetch(output_path: str, series_id: str, params: dict) -> None:
    """
    Fetch an IMF annual time series and write it to a date,value CSV.

    Constructs a URL of the form:
        /indicator/{indicator}/{country}
    and parses the nested JSON response to extract the year→value mapping.

    Year-value pairs where value is None (IMF uses null for missing data in
    JSON) are omitted from the output.  The rows are sorted oldest-first by
    year string (lexicographic sort works correctly for 4-digit years).
    """
    indicator = params.get("indicator")
    country   = params.get("country", "US")

    if not indicator:
        print("Error: params must include 'indicator'", file=sys.stderr)
        sys.exit(1)

    url = (
        f"{IMF_API}/indicator/{urllib.parse.quote(indicator)}"
        f"/{urllib.parse.quote(country)}"
    )

    try:
        req = urllib.request.Request(
            url,
            headers={
                "Accept":     "application/json",
                "User-Agent": "MAGI-DataFactory/1.0",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode())
    except urllib.error.URLError as exc:
        print(f"Error: IMF request failed: {exc}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as exc:
        print(f"Error: invalid JSON from IMF: {exc}", file=sys.stderr)
        sys.exit(1)

    # Navigate the nested response: values → indicator_code → country_code → {year: value}
    country_data = (
        raw.get("values", {})
           .get(indicator, {})
           .get(country, {})
    )

    if not country_data:
        print(
            f"Error: no data returned for indicator={indicator} country={country}",
            file=sys.stderr,
        )
        sys.exit(1)

    rows = sorted(country_data.items())   # sort by year string (lexicographic = chronological)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as f:
        f.write("date,value\n")
        for year, value in rows:
            if value is not None:   # skip IMF null entries
                f.write(f"{year},{value}\n")

    print(f"[imf] {indicator}/{country}: {len(rows)} rows → {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="IMF DataMapper macro adapter")
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
