#!/usr/bin/env bash
# refresh.sh - Refresh all data factory sources.
#
# Usage:
#   bash refresh.sh <SHARED_DIR>
#
# Environment (injected by daemon when run as a background job):
#   MAGI_TOOL_URL   — Tool API endpoint (default: http://localhost:4001)
#   MAGI_TOOL_TOKEN — Session bearer token
#
# Steps:
#   1. Check Python dependencies
#   2. Run all adapters via catalog.py refresh (non-FMP parallel, FMP sequential with budget guard)
#   3. For each news source: run process_news.py → digest.json
#   4. For each news digest: call magi-tool research to update brief.md
#   5. Log results

set -euo pipefail

SHARED_DIR="${1:?Usage: refresh.sh <SHARED_DIR>}"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FACTORY="${SHARED_DIR}/data-factory"
LOG="${FACTORY}/refresh.log"

mkdir -p "${FACTORY}"

{
echo "=== refresh.sh $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# ── Step 1: Python dependency check ──────────────────────────────────────────
echo "[refresh] Checking Python dependencies..."
if ! python3 -c "import requests" 2>/dev/null; then
    echo "[refresh] Installing Python requirements..."
    pip3 install -q -r "${SKILL_DIR}/requirements.txt"
fi
if ! python3 -c "import yfinance" 2>/dev/null; then
    echo "[refresh] Installing yfinance..."
    pip3 install -q yfinance
fi

# ── Step 2: Run adapters via catalog.py ───────────────────────────────────────
SOURCES="${FACTORY}/sources.json"
if [[ ! -f "${SOURCES}" ]]; then
    echo "[refresh] sources.json not found at ${SOURCES} — copying default"
    cp "${SKILL_DIR}/sources.json" "${SOURCES}"
fi

SCHEDULE="${FACTORY}/schedule.json"
if [[ ! -f "${SCHEDULE}" ]]; then
    cp "${SKILL_DIR}/schedule.json" "${SCHEDULE}"
fi

FMP_BUDGET=$(python3 -c "import json; d=json.load(open('${SCHEDULE}')); print(d.get('fmp_daily_budget',200))" 2>/dev/null || echo 200)
FMP_BUDGET_FILE="${FACTORY}/.fmp_usage_$(date -u +%Y-%m-%d)"

echo "[refresh] Running adapters (FMP budget: ${FMP_BUDGET}/day)..."
python3 "${SKILL_DIR}/scripts/catalog.py" refresh \
    "${FACTORY}" \
    "${SOURCES}" \
    --fmp-budget-file "${FMP_BUDGET_FILE}" \
    --fmp-budget "${FMP_BUDGET}" \
    --log "${LOG}"

echo "[refresh] Adapter refresh complete."

# ── Step 3: Process news digests ─────────────────────────────────────────────
echo "[refresh] Processing news digests..."

# Enumerate news sources from sources.json
python3 - <<'PYEOF'
import json, os, subprocess, sys

shared_dir = os.environ.get("FACTORY", "")
sources_path = os.path.join(shared_dir, "sources.json")
skill_dir = os.environ.get("SKILL_DIR", "")

if not os.path.exists(sources_path):
    print(f"[process_news] sources.json not found at {sources_path}", flush=True)
    sys.exit(0)

with open(sources_path) as f:
    sources = json.load(f)

for news_src in sources.get("news", []):
    src_id = news_src["id"]
    out_dir = os.path.join(shared_dir, news_src["output_dir"])
    raw_json = os.path.join(out_dir, "raw.json")
    digest_json = os.path.join(out_dir, "digest.json")

    if not os.path.exists(raw_json):
        print(f"[process_news] Skipping {src_id}: raw.json not found", flush=True)
        continue

    print(f"[process_news] Processing {src_id}...", flush=True)
    result = subprocess.run(
        [
            "python3",
            os.path.join(skill_dir, "scripts", "process_news.py"),
            "--raw", raw_json,
            "--existing", digest_json,
            "--output", digest_json,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"[process_news] Error for {src_id}: {result.stderr.strip()}", flush=True)
    else:
        print(result.stdout.strip(), flush=True)
PYEOF

# ── Step 4: Update news briefs via magi-tool research ────────────────────────
# Only proceed if MAGI_TOOL_TOKEN is set (i.e. running as a background job)
if [[ -z "${MAGI_TOOL_TOKEN:-}" ]]; then
    echo "[refresh] MAGI_TOOL_TOKEN not set — skipping news brief synthesis (run as background job to enable)"
else
    echo "[refresh] Updating news briefs via Research tool..."

    python3 - <<'PYEOF'
import json, os, subprocess, sys

shared_dir = os.environ.get("FACTORY", "")
sources_path = os.path.join(shared_dir, "sources.json")

if not os.path.exists(sources_path):
    sys.exit(0)

with open(sources_path) as f:
    sources = json.load(f)

schedule_path = os.path.join(shared_dir, "schedule.json")
schedule = {}
if os.path.exists(schedule_path):
    with open(schedule_path) as f:
        schedule = json.load(f)

max_fetch = schedule.get("news_max_articles_fetch", 5)

for news_src in sources.get("news", []):
    src_id = news_src["id"]
    out_dir = os.path.join(shared_dir, news_src["output_dir"])
    digest_json = os.path.join(out_dir, "digest.json")
    brief_md = os.path.join(out_dir, "brief.md")

    if not os.path.exists(digest_json):
        print(f"[brief] Skipping {src_id}: digest.json not found", flush=True)
        continue

    # Check if there are any new items worth synthesizing
    with open(digest_json) as f:
        digest = json.load(f)
    items = digest.get("items", [])
    new_items = [it for it in items if it.get("is_new")]
    if not new_items:
        print(f"[brief] No new items for {src_id}, skipping synthesis", flush=True)
        continue

    print(f"[brief] Synthesizing brief for {src_id} ({len(new_items)} new items)...", flush=True)

    # Build context files list
    context_args = ["--context-file", digest_json]
    if os.path.exists(brief_md):
        context_args += ["--context-file", brief_md]

    result = subprocess.run(
        [
            "magi-tool", "research",
            "--question",
            (
                f"Update the NVDA news brief based on today's digest. "
                f"Fetch up to {max_fetch} new articles (use the URLs in the digest). "
                f"Keep the previous brief's structure. Note what changed since yesterday. "
                f"Include a Sources section with URLs."
            ),
            *context_args,
            "--output", brief_md,
            "--max-age-hours", "0",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"[brief] Error for {src_id}: {result.stderr.strip()}", flush=True)
    else:
        print(f"[brief] Updated {brief_md}", flush=True)
PYEOF
fi

# ── Step 5: Print catalog summary ─────────────────────────────────────────────
echo "[refresh] Current catalog:"
python3 "${SKILL_DIR}/scripts/catalog.py" list "${FACTORY}" || true

echo "=== refresh.sh done $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
} 2>&1 | tee -a "${LOG}"
