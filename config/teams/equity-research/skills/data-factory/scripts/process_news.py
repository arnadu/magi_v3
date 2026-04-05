#!/usr/bin/env python3
"""
process_news.py - De-duplicate, rank, and produce a news digest.

Reads raw adapter output, compares against existing digest to mark new items,
deduplicates by URL and near-identical title, ranks by recency and relevance,
and writes an updated digest.json.

Usage:
  python3 process_news.py \
    --raw     <path/to/raw.json> \
    --existing <path/to/digest.json>  (may not exist on first run) \
    --output  <path/to/digest.json>
"""

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


MAX_ITEMS = 30

# Keywords that boost relevance score for NVDA research
RELEVANCE_KEYWORDS = [
    "nvidia", "nvda", "gpu", "datacenter", "data center",
    "ai chip", "h100", "h200", "blackwell", "hopper",
    "jensen huang", "cuda", "inference", "training",
    "amd", "intel", "tsmc", "semiconductor",
]


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------

def _normalise_title(title: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    t = title.lower()
    t = re.sub(r"[^\w\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _levenshtein_ratio(a: str, b: str) -> float:
    """Normalised Levenshtein similarity in [0, 1]. 1 = identical."""
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    # DP on shorter string
    if len(a) > len(b):
        a, b = b, a
    prev = list(range(len(a) + 1))
    for j, cb in enumerate(b, 1):
        curr = [j]
        for i, ca in enumerate(a, 1):
            insert = curr[i - 1] + 1
            delete = prev[i] + 1
            replace = prev[i - 1] + (0 if ca == cb else 1)
            curr.append(min(insert, delete, replace))
        prev = curr
    distance = prev[len(a)]
    max_len = max(len(a), len(b))
    return 1.0 - distance / max_len


def deduplicate(items: list[dict]) -> list[dict]:
    """Remove items with duplicate URLs or near-identical titles (ratio > 0.85)."""
    seen_urls: set[str] = set()
    seen_titles: list[str] = []
    result = []
    for item in items:
        url = (item.get("url") or "").strip().rstrip("/")
        if url in seen_urls:
            continue

        norm = _normalise_title(item.get("title") or "")
        if any(_levenshtein_ratio(norm, t) > 0.85 for t in seen_titles):
            continue

        seen_urls.add(url)
        seen_titles.append(norm)
        result.append(item)
    return result


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------

def _relevance_score(item: dict) -> float:
    text = " ".join([
        (item.get("title") or ""),
        (item.get("description") or ""),
        (item.get("summary") or ""),
    ]).lower()
    score = 0.0
    for kw in RELEVANCE_KEYWORDS:
        if kw in text:
            score += 1.0
    return score


def _published_dt(item: dict) -> datetime:
    raw = item.get("published_at") or item.get("publishedAt") or ""
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return datetime.min.replace(tzinfo=timezone.utc)


def rank(items: list[dict]) -> list[dict]:
    """Sort by (relevance score desc, published_at desc)."""
    return sorted(
        items,
        key=lambda x: (_relevance_score(x), _published_dt(x)),
        reverse=True,
    )


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------

def normalise(item: dict) -> dict:
    """Produce a uniform digest item regardless of adapter source format."""
    return {
        "title":        item.get("title") or "",
        "url":          item.get("url") or item.get("link") or "",
        "source":       item.get("source") or item.get("source_name") or "",
        "published_at": item.get("published_at") or item.get("publishedAt") or "",
        "summary":      item.get("description") or item.get("summary") or "",
    }


# ---------------------------------------------------------------------------
# is_new marking
# ---------------------------------------------------------------------------

def mark_new(items: list[dict], existing_digest: dict) -> list[dict]:
    """Set is_new=True for items whose URL is not in the existing digest."""
    existing_urls: set[str] = {
        (i.get("url") or "").strip().rstrip("/")
        for i in existing_digest.get("items", [])
    }
    result = []
    for item in items:
        url = (item.get("url") or "").strip().rstrip("/")
        result.append({**item, "is_new": url not in existing_urls})
    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def process(raw_path: str, existing_path: str | None, output_path: str) -> None:
    raw_data = json.loads(Path(raw_path).read_text())

    # Raw may be a list or {"articles": [...]} or {"data": [...]}
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

    # Load existing digest to determine is_new
    existing_digest: dict = {}
    if existing_path:
        ep = Path(existing_path)
        if ep.exists():
            try:
                existing_digest = json.loads(ep.read_text())
            except (json.JSONDecodeError, AttributeError):
                pass

    # Normalise
    items = [normalise(i) for i in raw_items if i.get("url") or i.get("link")]

    # Deduplicate
    items = deduplicate(items)

    # Rank
    items = rank(items)

    # Truncate
    items = items[:MAX_ITEMS]

    # Mark is_new
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
    parser = argparse.ArgumentParser(description="News digest processor")
    parser.add_argument("--raw",      required=True, help="Raw adapter output JSON")
    parser.add_argument("--existing", default=None,  help="Previous digest JSON (optional)")
    parser.add_argument("--output",   required=True, help="Output digest JSON path")
    args = parser.parse_args()
    process(args.raw, args.existing, args.output)


if __name__ == "__main__":
    main()
