#!/usr/bin/env python3
"""
adapter_newsapi.py - Fetch news headlines from NewsAPI.org.

Requires: NEWSAPIORG_API_KEY environment variable.
Free tier: 100 req/day, last 30 days, register at newsapi.org.

Usage:
  python3 adapter_newsapi.py --discover
  python3 adapter_newsapi.py --fetch <output.json> --series-id <id> \
    --params '{"q":"NVIDIA GPU datacenter","language":"en","pageSize":30}'
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


NEWSAPI_URL = "https://newsapi.org/v2/everything"


def discover() -> None:
    print(json.dumps({
        "adapter": "newsapi",
        "description": "NewsAPI.org headlines. Requires NEWSAPIORG_API_KEY. Free: 100 req/day.",
        "series": [
            {
                "id": "newsapi/nvda_competitive_landscape",
                "params": {"q": "NVIDIA GPU datacenter AI chip", "language": "en", "pageSize": 30},
                "description": "NVDA competitive landscape news",
            },
        ],
        "param_schema": {
            "q":        "Search query (NewsAPI query syntax supported)",
            "language": "ISO 639-1 language code (default: en)",
            "pageSize": "Max articles (default: 20, max: 100)",
            "sortBy":   "relevancy | popularity | publishedAt (default: publishedAt)",
        },
    }, indent=2))


def fetch(output_path: str, series_id: str, params: dict) -> None:
    api_key = os.environ.get("NEWSAPIORG_API_KEY")
    if not api_key:
        print("Error: NEWSAPIORG_API_KEY environment variable not set", file=sys.stderr)
        sys.exit(1)

    api_params = {
        "q":        params.get("q", "NVIDIA"),
        "language": params.get("language", "en"),
        "pageSize": str(min(int(params.get("pageSize", 20)), 100)),
        "sortBy":   params.get("sortBy", "publishedAt"),
        "apiKey":   api_key,
    }

    url = f"{NEWSAPI_URL}?{urllib.parse.urlencode(api_params)}"

    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            raw = json.loads(resp.read().decode())
    except urllib.error.URLError as exc:
        print(f"Error: NewsAPI request failed: {exc}", file=sys.stderr)
        sys.exit(1)

    if raw.get("status") != "ok":
        msg = raw.get("message", "unknown error")
        print(f"Error: NewsAPI returned error: {msg}", file=sys.stderr)
        sys.exit(1)

    articles = raw.get("articles", [])

    # Normalise to common format
    items = []
    for a in articles:
        source = a.get("source") or {}
        items.append({
            "title":        a.get("title") or "",
            "url":          a.get("url") or "",
            "source":       source.get("name") or "",
            "published_at": a.get("publishedAt") or "",
            "summary":      a.get("description") or "",
        })

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(items, indent=2, ensure_ascii=False))
    print(f"[newsapi] {api_params['q']!r}: {len(items)} articles → {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="NewsAPI adapter")
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
