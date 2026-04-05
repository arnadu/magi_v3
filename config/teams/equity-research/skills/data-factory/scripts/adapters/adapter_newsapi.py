#!/usr/bin/env python3
"""
adapter_newsapi.py — News headlines from NewsAPI.org.

PURPOSE
-------
NewsAPI.org aggregates headlines from thousands of English-language news sources
worldwide.  This adapter queries the "everything" endpoint using a topic-specific
search query and writes a normalised JSON array of articles.

The output is consumed by process_news.py, which deduplicates, ranks, and
produces digest.json.  The LLM synthesis step (magi-tool research) then reads
the digest and selectively fetches full article text via FetchUrl.

Requires: NEWSAPIORG_API_KEY environment variable.
Free tier: 100 requests/day, last 30 days of articles.
Register at: https://newsapi.org

OUTPUT FORMAT (JSON array)
--------------------------
  [
    {
      "title":        "NVIDIA Reports Record Revenue",
      "url":          "https://...",
      "source":       "Reuters",
      "published_at": "2026-04-03T14:00:00Z",
      "summary":      "NVIDIA Corporation today reported..."
    },
    ...
  ]

DEPENDENCY
----------
None (stdlib only: urllib.request, json).

USAGE
-----
  python3 adapter_newsapi.py --discover
  python3 adapter_newsapi.py --fetch <output.json> --series-id <id> \\
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


# NewsAPI v2 "everything" endpoint
NEWSAPI_URL = "https://newsapi.org/v2/everything"


def discover() -> None:
    """
    Print adapter metadata as JSON to stdout.

    The default query is tuned for NVDA competitive landscape coverage:
    GPU, datacenter, and AI chip keywords surface relevant stories while
    avoiding generic "NVIDIA" results that are about consumer graphics cards.
    """
    print(json.dumps({
        "adapter": "newsapi",
        "description": "NewsAPI.org headlines. Requires NEWSAPIORG_API_KEY. Free: 100 req/day.",
        "series": [
            {
                "id": "newsapi/nvda_competitive_landscape",
                "params": {
                    "q":        "NVIDIA GPU datacenter AI chip",
                    "language": "en",
                    "pageSize": 30,
                },
                "description": "NVDA competitive landscape news (English)",
            },
        ],
        "param_schema": {
            "q":        "Search query (NewsAPI query syntax: AND, OR, NOT, quotes)",
            "language": "ISO 639-1 language code (default: en)",
            "pageSize": "Max articles per request (default: 20, max: 100)",
            "sortBy":   "relevancy | popularity | publishedAt (default: publishedAt)",
        },
    }, indent=2))


def fetch(output_path: str, series_id: str, params: dict) -> None:
    """
    Query NewsAPI and write normalised articles to a JSON file.

    Reads NEWSAPIORG_API_KEY from the environment.  The API key is passed in
    the query string (NewsAPI's required auth method) — it is not logged.

    pageSize is capped at 100 (NewsAPI maximum).  The response is normalised
    to the common news item schema (title, url, source, published_at, summary)
    that process_news.py expects.  Exits with code 1 on API or network errors.
    """
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

    # NewsAPI signals errors with status != "ok" even on HTTP 200
    if raw.get("status") != "ok":
        msg = raw.get("message", "unknown error")
        print(f"Error: NewsAPI returned error: {msg}", file=sys.stderr)
        sys.exit(1)

    articles = raw.get("articles", [])

    # Normalise to the common news item schema
    items = []
    for a in articles:
        source = a.get("source") or {}
        items.append({
            "title":        a.get("title")       or "",
            "url":          a.get("url")          or "",
            "source":       source.get("name")    or "",   # NewsAPI nests source in {"id","name"}
            "published_at": a.get("publishedAt")  or "",
            "summary":      a.get("description")  or "",   # "description" is NewsAPI's summary field
        })

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(items, indent=2, ensure_ascii=False))
    print(f"[newsapi] {api_params['q']!r}: {len(items)} articles → {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="NewsAPI.org news adapter")
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
