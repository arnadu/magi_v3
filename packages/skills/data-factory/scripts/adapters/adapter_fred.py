#!/usr/bin/env magi-python3
"""
adapter_fred.py — Macro time-series from FRED (Federal Reserve Economic Data).

PURPOSE
-------
FRED is the St. Louis Fed's public database of over 800,000 economic time
series: interest rates, inflation, unemployment, yield curves, and more.
This adapter fetches individual series by their FRED series ID and writes
them as two-column CSVs (date, value) for use by Marco (Economist) and Sam.

Requires: FRED_API_KEY configured on the daemon (CR-04 — this adapter never
sees the key itself; it calls the "data-fred" tool via magi-tool, which the
daemon serves using its own copy of the key).
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
None (stdlib only: subprocess, json) — calls the daemon-installed `magi-tool`
CLI rather than the FRED API directly (CR-04).

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
import subprocess
import sys
from pathlib import Path


def _call_magi_tool(tool_name: str, params: dict) -> dict:
    """
    Call a daemon-side tool via the magi-tool CLI (CR-04 job-env half) and
    return its parsed JSON response.

    Background jobs no longer receive raw provider API keys in their own
    env — the daemon holds them and serves scoped tools (data-fred,
    data-fmp, data-newsapi) over the loopback ToolApiServer instead. This
    mirrors magi_tool.py's call_tool(), reimplemented via the CLI (not a
    cross-skill Python import) so this adapter stays self-contained.

    Raises RuntimeError on a non-zero exit or a {"error": ...} response.
    """
    result = subprocess.run(
        ["magi-tool", tool_name, "--params", json.dumps(params)],
        capture_output=True, text=True, timeout=35,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "magi-tool call failed").strip())
    response = json.loads(result.stdout)
    if "error" in response:
        raise RuntimeError(response["error"])
    return response


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

    The default lookback window is 2 years (730 days), which is sufficient
    for daily and monthly series used in short-term equity analysis.  Agents
    can extend this via the observation_start param.

    FRED returns "." for missing observations (e.g. non-business days for
    daily series); these rows are filtered out before writing.
    """
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

    try:
        response = _call_magi_tool("data-fred", {
            "seriesId": fred_series,
            "observationStart": start,
        })
    except Exception as exc:
        print(f"Error: FRED request failed: {exc}", file=sys.stderr)
        sys.exit(1)

    raw = json.loads(response["result"]["content"][0]["text"])
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
