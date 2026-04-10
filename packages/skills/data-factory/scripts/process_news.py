#!/usr/bin/env magi-python3
"""
process_news.py — News de-duplication, ranking, and digest production.

PURPOSE
-------
This script sits between the raw adapter output and the LLM synthesis step.
Its job is entirely mechanical (no tokens consumed):

  1. Normalise — map each adapter's idiosyncratic field names to the common
     digest item schema so downstream code never has to know which adapter
     produced the data.

  2. Deduplicate — remove items that are the same story as one already seen,
     detected by either:
       a. Exact URL match (trailing slashes stripped, case-sensitive).
       b. Near-identical title: normalised Levenshtein similarity > 0.85.
     This keeps the LLM synthesis step focused on distinct stories.

  3. Rank — sort items by (relevance_score DESC, published_at DESC).
     Relevance is a keyword hit-count over title + summary (NVDA-specific
     keywords defined in RELEVANCE_KEYWORDS). A very recent article about AMD
     or TSMC ranks above a week-old story about an unrelated company.

  4. Truncate — cap output at MAX_ITEMS (30) to bound LLM context cost.

  5. Mark new — compare against the previous digest (if it exists) and set
     is_new=True for URLs that were not in yesterday's run.  The LLM uses
     is_new to decide which articles are worth fetching in full.

CALL SEQUENCE (inside refresh.sh)
----------------------------------
  # Step 1: adapter writes raw.json (list of articles, adapter-specific schema)
  python3 adapter_newsapi.py --fetch $FACTORY/news/nvda/raw.json ...

  # Step 2: process_news converts raw → digest.json (normalised, deduped, ranked)
  python3 process_news.py \
      --raw      $FACTORY/news/nvda/raw.json \
      --existing $FACTORY/news/nvda/digest.json \
      # (--existing may not exist on first run; process() handles missing file)
      --output   $FACTORY/news/nvda/digest.json

  # Step 3: Research tool reads digest.json + brief.md and synthesises a new brief
  magi-tool research --context-file digest.json --context-file brief.md ...

DATA MODEL
----------
Input (raw.json): JSON array of adapter-specific article objects.
  Each adapter may use different field names; normalise() maps them to the
  canonical schema below.

Output (digest.json):
  {
    "generated_at": "2026-04-04T05:31:00+00:00",  # ISO-8601 UTC
    "items": [
      {
        "title":        "NVIDIA announces ...",
        "url":          "https://...",
        "source":       "Reuters",            # publication name
        "published_at": "2026-04-03T14:22:00+00:00",
        "summary":      "...",                # may be empty
        "is_new":       true                  # false if URL was in previous digest
      },
      ...                                     # max 30 items, ranked by relevance
    ]
  }

USAGE
-----
  python3 process_news.py
    --raw     <path/to/raw.json>
    --existing <path/to/digest.json>   (optional; omit or missing -> all items are new)
    --output  <path/to/digest.json>
"""

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


MAX_ITEMS = 30

# Keywords scored against title + summary to compute relevance.
# Each keyword that appears adds 1.0 to the item's score.
# Order does not matter; all keywords are checked independently.
RELEVANCE_KEYWORDS = [
    "nvidia", "nvda", "gpu", "datacenter", "data center",
    "ai chip", "h100", "h200", "blackwell", "hopper",
    "jensen huang", "cuda", "inference", "training",
    "amd", "intel", "tsmc", "semiconductor",
]


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------

def normalise(item: dict) -> dict:
    """
    Map an adapter-specific article dict to the canonical digest item schema.

    Different adapters use different field names (e.g. NewsAPI uses
    "publishedAt"; GDELT uses "seendate" already converted to published_at by
    the adapter; FMP uses its own schema).  This function abstracts all of
    that away so the rest of the pipeline works with a single schema.

    Items missing both "url" and "link" are dropped before this function is
    called, so the output "url" field is always non-empty.
    """
    return {
        "title":        item.get("title") or "",
        "url":          item.get("url") or item.get("link") or "",
        "source":       item.get("source") or item.get("source_name") or "",
        "published_at": item.get("published_at") or item.get("publishedAt") or "",
        "summary":      item.get("description") or item.get("summary") or "",
    }


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------

def _normalise_title(title: str) -> str:
    """
    Prepare a title string for fuzzy comparison.

    Lowercases, strips all punctuation (replaced with spaces), and collapses
    consecutive whitespace to a single space.  This makes minor formatting
    differences (em-dashes, colons, etc.) invisible to the similarity check.
    """
    t = title.lower()
    t = re.sub(r"[^\w\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _levenshtein_ratio(a: str, b: str) -> float:
    """
    Compute the normalised Levenshtein similarity between two strings.

    Returns a float in [0, 1] where 1.0 means identical and 0.0 means
    completely different.  Computed as:
        1 - edit_distance(a, b) / max(len(a), len(b))

    Uses an O(min(|a|,|b|)) space DP implementation (two rolling rows).
    This is fast enough for the short strings produced by _normalise_title.
    """
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    # Always iterate over the longer string, keep the shorter one in the inner array
    if len(a) > len(b):
        a, b = b, a
    prev = list(range(len(a) + 1))
    for j, cb in enumerate(b, 1):
        curr = [j]
        for i, ca in enumerate(a, 1):
            insert  = curr[i - 1] + 1
            delete  = prev[i] + 1
            replace = prev[i - 1] + (0 if ca == cb else 1)
            curr.append(min(insert, delete, replace))
        prev = curr
    distance = prev[len(a)]
    max_len = max(len(a), len(b))
    return 1.0 - distance / max_len


def deduplicate(items: list[dict]) -> list[dict]:
    """
    Remove duplicate articles from the item list.

    An item is considered a duplicate of an earlier one if:
      - Its URL (trailing-slash-normalised) matches exactly, OR
      - Its normalised title has Levenshtein similarity > 0.85 with any
        already-accepted title.

    The first occurrence is kept; later duplicates are dropped.
    Input order is preserved for non-duplicates, which matters because rank()
    is called after this function.
    """
    seen_urls:   set[str]  = set()
    seen_titles: list[str] = []
    result = []

    for item in items:
        url = (item.get("url") or "").strip().rstrip("/")
        if url in seen_urls:
            continue  # exact URL duplicate

        norm = _normalise_title(item.get("title") or "")
        if any(_levenshtein_ratio(norm, t) > 0.85 for t in seen_titles):
            continue  # near-identical title duplicate

        seen_urls.add(url)
        seen_titles.append(norm)
        result.append(item)

    return result


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------

def _relevance_score(item: dict) -> float:
    """
    Count how many RELEVANCE_KEYWORDS appear in the item's text fields.

    Concatenates title + description + summary (all lowercased), then counts
    keyword hits.  Each keyword contributes 1.0 regardless of how many times
    it appears.  Returns 0.0 for an item with no keyword matches.
    """
    text = " ".join([
        (item.get("title")       or ""),
        (item.get("description") or ""),
        (item.get("summary")     or ""),
    ]).lower()
    return sum(1.0 for kw in RELEVANCE_KEYWORDS if kw in text)


def _published_dt(item: dict) -> datetime:
    """
    Parse the item's publication timestamp into a timezone-aware datetime.

    Returns datetime.min (UTC) for items with a missing or unparseable
    timestamp so they sort to the bottom of the ranked list.
    """
    raw = item.get("published_at") or item.get("publishedAt") or ""
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return datetime.min.replace(tzinfo=timezone.utc)


def rank(items: list[dict]) -> list[dict]:
    """
    Sort items by (relevance_score DESC, published_at DESC).

    Primary sort is relevance: an article that mentions NVIDIA, GPU, and Blackwell
    ranks above one that only mentions "semiconductor".  Within the same relevance
    band, newer articles rank first.

    Note: this function returns a new sorted list; it does NOT truncate to
    MAX_ITEMS — that happens in process() after this call.
    """
    return sorted(
        items,
        key=lambda x: (_relevance_score(x), _published_dt(x)),
        reverse=True,
    )


# ---------------------------------------------------------------------------
# is_new marking
# ---------------------------------------------------------------------------

def mark_new(items: list[dict], existing_digest: dict) -> list[dict]:
    """
    Set the is_new flag on each item based on comparison with the previous digest.

    An item is "new" if its URL was not present in existing_digest["items"].
    The LLM synthesis step uses is_new to prioritise which articles to fetch
    in full (only new ones are worth fetching; old ones were already processed
    in a previous run).

    existing_digest may be an empty dict (first run or missing file) — in that
    case all items are marked is_new=True.
    """
    existing_urls: set[str] = {
        (i.get("url") or "").strip().rstrip("/")
        for i in existing_digest.get("items", [])
    }
    return [
        {**item, "is_new": (item.get("url") or "").strip().rstrip("/") not in existing_urls}
        for item in items
    ]


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def process(raw_path: str, existing_path: str | None, output_path: str) -> None:
    """
    Full pipeline: load raw → normalise → deduplicate → rank → truncate → mark_new → write.

    raw_path      — path to the adapter's raw output JSON (array or object with
                    "articles" / "data" / "items" key).
    existing_path — path to the previous digest.json, or None.  Missing file is
                    silently treated as an empty digest.
    output_path   — destination for the updated digest.json.
    """
    raw_data = json.loads(Path(raw_path).read_text())

    # Adapters may return a bare list or wrap it in a well-known key
    if isinstance(raw_data, list):
        raw_items = raw_data
    elif isinstance(raw_data, dict):
        raw_items = (
            raw_data.get("articles")
            or raw_data.get("data")
            or raw_data.get("items")
            or []
        )
    else:
        raw_items = []

    # Load the previous digest (if any) so we can detect new items
    existing_digest: dict = {}
    if existing_path:
        ep = Path(existing_path)
        if ep.exists():
            try:
                existing_digest = json.loads(ep.read_text())
            except (json.JSONDecodeError, AttributeError):
                pass  # corrupt or empty file — treat as no existing digest

    # Pipeline: normalise → deduplicate → rank → truncate → mark_new
    items = [normalise(i) for i in raw_items if i.get("url") or i.get("link")]
    items = deduplicate(items)
    items = rank(items)
    items = items[:MAX_ITEMS]
    items = mark_new(items, existing_digest)

    digest = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "items": items,
    }

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(digest, indent=2, ensure_ascii=False))

    new_count = sum(1 for i in items if i["is_new"])
    print(f"[process_news] {len(items)} items ({new_count} new) → {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="De-duplicate, rank, and produce a news digest from raw adapter output."
    )
    parser.add_argument("--raw",      required=True,
                        help="Raw adapter output JSON (list of articles)")
    parser.add_argument("--existing", default=None,
                        help="Previous digest.json for is_new comparison (optional)")
    parser.add_argument("--output",   required=True,
                        help="Destination digest.json path")
    args = parser.parse_args()
    process(args.raw, args.existing, args.output)


if __name__ == "__main__":
    main()
