#!/usr/bin/env magi-python3
"""
adapter_gdelt.py — News articles from the GDELT Project GKG API v2.

PURPOSE
-------
GDELT (Global Database of Events, Language, and Tone) monitors broadcast,
print, and web news across the world in real time.  This adapter queries the
Article List ("ArtList") mode to retrieve recent news articles matching a
search query.

No API key required.  GDELT is a public, free service run by Google Jigsaw.

This adapter complements NewsAPI: GDELT has broader geographic coverage and
no daily request limit, but it covers only the last few days (timespan=3d)
and does not provide article summaries.

OUTPUT FORMAT (JSON array)
--------------------------
  [
    {
      "title":        "NVIDIA shares surge after earnings beat",
      "url":          "https://...",
      "source":       "reuters.com",          # domain name, not publication title
      "published_at": "2026-04-03T14:00:00+00:00",  # ISO-8601 UTC
      "summary":      ""                      # GDELT does not provide summaries
    },
    ...
  ]

DEPENDENCY
----------
None (stdlib only: urllib.request, json).

USAGE
-----
  python3 adapter_gdelt.py --discover
  python3 adapter_gdelt.py --fetch <output.json> --series-id <id> \\
      --params '{"query":"NVIDIA","max_records":30}'
"""

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


# GDELT Document API v2 base URL
GDELT_API = "https://api.gdeltproject.org/api/v2/doc/doc"


def discover() -> None:
    """
    Print adapter metadata as JSON to stdout.

    Describes default series and the full parameter schema.  Called by
    catalog.py to populate the list of available sources.
    """
    print(json.dumps({
        "adapter": "gdelt",
        "description": "GDELT Project news search. No API key required.",
        "series": [
            {
                "id": "gdelt/nvidia_news",
                "params": {"query": "NVIDIA", "max_records": 30},
                "description": "NVIDIA mentions in global news (last 3 days)",
            },
        ],
        "param_schema": {
            "query":       "Search query string (GDELT query syntax supported)",
            "max_records": "Max articles to return (default: 25, max: 250)",
            "mode":        "ArtList (article list) or TimelineVol (volume) — default: ArtList",
        },
    }, indent=2))


def fetch(output_path: str, series_id: str, params: dict) -> None:
    """
    Query GDELT and write normalised articles to a JSON file.

    Sends a GET request to the GDELT API with timespan=3d (the maximum
    available window on the free endpoint).  The response is a JSON object
    with an "articles" array; each article is normalised to the common schema
    and written as a JSON array.

    The User-Agent header is set to identify MAGI requests, which is good
    practice for public APIs.  Exits with code 1 on HTTP or JSON errors.
    """
    query      = params.get("query", "NVIDIA")
    max_records = int(params.get("max_records", 25))
    mode       = params.get("mode", "ArtList")

    api_params = {
        "query":      query,
        "mode":       mode,
        "maxrecords": str(min(max_records, 250)),
        "format":     "json",
        "sort":       "DateDesc",
        "timespan":   "3d",   # last 3 days — maximum window on the free endpoint
    }

    url = f"{GDELT_API}?{urllib.parse.urlencode(api_params)}"

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "MAGI-DataFactory/1.0"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read().decode()
    except urllib.error.HTTPError as exc:
        print(f"Error: GDELT HTTP {exc.code}: {exc.reason}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as exc:
        print(f"Error: GDELT request failed: {exc}", file=sys.stderr)
        sys.exit(1)

    # GDELT returns plain text on rate-limit or error (not JSON).
    # Detect this before json.loads to produce a clear error message.
    stripped = data.strip()
    if not stripped.startswith(("{", "[")):
        msg = stripped[:200].replace("\n", " ")
        print(f"Error: non-JSON response from GDELT: {msg}", file=sys.stderr)
        sys.exit(1)

    try:
        raw = json.loads(data)
    except json.JSONDecodeError as exc:
        print(f"Error: invalid JSON from GDELT: {exc}", file=sys.stderr)
        sys.exit(1)

    articles = raw.get("articles") or []

    # Normalise to the common news item schema used by process_news.py
    items = [
        {
            "title":        a.get("title") or "",
            "url":          a.get("url") or "",
            "source":       a.get("domain") or "",     # GDELT gives domain, not publication name
            "published_at": _parse_gdelt_date(a.get("seendate") or ""),
            "summary":      "",   # GDELT does not provide article summaries
        }
        for a in articles
    ]

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(items, indent=2, ensure_ascii=False))
    print(f"[gdelt] {query!r}: {len(items)} articles → {output_path}")


def _parse_gdelt_date(s: str) -> str:
    """
    Convert GDELT's compact date format to ISO-8601.

    GDELT timestamps look like "20260404T060000Z" (YYYYMMDDTHHMMSSz).
    Returns the original string unchanged if parsing fails, so the article
    is still included in the output with an unparsed timestamp rather than
    being silently dropped.
    """
    if not s:
        return ""
    try:
        dt = datetime.strptime(s, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        return dt.isoformat(timespec="seconds")
    except ValueError:
        return s   # pass through unrecognised formats


def main() -> None:
    parser = argparse.ArgumentParser(description="GDELT news adapter")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--discover", action="store_true",
                       help="Print adapter metadata JSON and exit")
    group.add_argument("--fetch", metavar="OUTPUT_PATH",
                       help="Fetch articles and write JSON to this path")
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
