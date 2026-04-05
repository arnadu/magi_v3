#!/usr/bin/env python3
"""
adapter_gdelt.py - Fetch news from GDELT Project GKG API.

No API key required. Returns news articles matching a query.

Usage:
  python3 adapter_gdelt.py --discover
  python3 adapter_gdelt.py --fetch <output.json> --series-id <id> --params '{"query":"NVIDIA","max_records":30}'
"""

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


GDELT_API = "https://api.gdeltproject.org/api/v2/doc/doc"


def discover() -> None:
    print(json.dumps({
        "adapter": "gdelt",
        "description": "GDELT Project news search. No API key required.",
        "series": [
            {
                "id": "gdelt/nvidia_news",
                "params": {"query": "NVIDIA", "max_records": 30},
                "description": "NVIDIA mentions in global news",
            },
        ],
        "param_schema": {
            "query": "Search query string",
            "max_records": "Max articles to return (default: 25, max: 250)",
            "mode": "ArtList (articles) or TimelineVol (volume) — default: ArtList",
        },
    }, indent=2))


def fetch(output_path: str, series_id: str, params: dict) -> None:
    query = params.get("query", "NVIDIA")
    max_records = int(params.get("max_records", 25))
    mode = params.get("mode", "ArtList")

    api_params = {
        "query": query,
        "mode": mode,
        "maxrecords": str(min(max_records, 250)),
        "format": "json",
        "sort": "DateDesc",
        "timespan": "3d",  # last 3 days
    }

    url = f"{GDELT_API}?{urllib.parse.urlencode(api_params)}"

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "MAGI-DataFactory/1.0"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode())
    except urllib.error.URLError as exc:
        print(f"Error: GDELT request failed: {exc}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as exc:
        print(f"Error: invalid JSON from GDELT: {exc}", file=sys.stderr)
        sys.exit(1)

    articles = raw.get("articles") or []

    # Normalise to common format
    items = []
    for a in articles:
        items.append({
            "title":        a.get("title") or "",
            "url":          a.get("url") or "",
            "source":       a.get("domain") or "",
            "published_at": _parse_gdelt_date(a.get("seendate") or ""),
            "summary":      "",  # GDELT doesn't provide summaries
        })

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(items, indent=2, ensure_ascii=False))
    print(f"[gdelt] {query}: {len(items)} articles → {output_path}")


def _parse_gdelt_date(s: str) -> str:
    """Convert GDELT date format YYYYMMDDTHHMMSSZ to ISO-8601."""
    if not s:
        return ""
    try:
        dt = datetime.strptime(s, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        return dt.isoformat(timespec="seconds")
    except ValueError:
        return s


def main() -> None:
    parser = argparse.ArgumentParser(description="GDELT adapter")
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
