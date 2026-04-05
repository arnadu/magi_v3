#!/usr/bin/env bash
# read-digest.sh - Print new items from a news digest.
#
# Usage:
#   bash read-digest.sh <news-id> [--all]
#
# Examples:
#   bash read-digest.sh nvda_competitive_landscape          # new items only
#   bash read-digest.sh nvda_competitive_landscape --all    # all items
#   bash read-digest.sh nvda_gdelt
#
# Env:
#   SHARED_DIR  — mission shared directory (set by agent runtime)

set -euo pipefail

NEWS_ID="${1:?Usage: read-digest.sh <news-id> [--all]}"
ALL=0

shift
while [[ $# -gt 0 ]]; do
    case "$1" in
        --all) ALL=1; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

FACTORY="${SHARED_DIR:?SHARED_DIR not set}/data-factory"
DIGEST="${FACTORY}/news/${NEWS_ID}/digest.json"

if [[ ! -f "${DIGEST}" ]]; then
    echo "Digest not found: ${DIGEST}" >&2
    echo "Available digests:"
    ls "${FACTORY}/news/" 2>/dev/null || echo "  (none)"
    exit 1
fi

python3 - "${DIGEST}" "${ALL}" <<'PYEOF'
import json, sys

digest_path = sys.argv[1]
show_all = sys.argv[2] == "1"

with open(digest_path) as f:
    digest = json.load(f)

generated_at = digest.get("generated_at", "unknown")
items = digest.get("items", [])
filtered = items if show_all else [it for it in items if it.get("is_new")]

print(f"Generated: {generated_at}  |  {len(filtered)} item(s) shown of {len(items)} total\n")

col_w = {"title": 60, "source": 20, "published_at": 22}

header = (
    f"{'#':<4} "
    f"{'NEW':<5} "
    f"{'Title':<{col_w['title']}} "
    f"{'Source':<{col_w['source']}} "
    f"{'Published':<{col_w['published_at']}} "
    f"URL"
)
print(header)
print("-" * (len(header) + 20))

for i, it in enumerate(filtered, 1):
    new_flag = "Y" if it.get("is_new") else " "
    title = it.get("title", "")[:col_w["title"]]
    source = it.get("source", "")[:col_w["source"]]
    pub = it.get("published_at", "")[:col_w["published_at"]]
    url = it.get("url", "")
    print(
        f"{i:<4} "
        f"{new_flag:<5} "
        f"{title:<{col_w['title']}} "
        f"{source:<{col_w['source']}} "
        f"{pub:<{col_w['published_at']}} "
        f"{url}"
    )
PYEOF
