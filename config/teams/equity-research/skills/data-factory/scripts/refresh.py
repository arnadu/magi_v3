#!/usr/bin/env magi-python3
"""
refresh.py — Data factory full refresh orchestrator.

PURPOSE
-------
This is the single entry point for refreshing all data factory sources.
It is called daily by the scheduled background job (via refresh.sh) and can
also be run manually by the data-scientist agent for an immediate refresh.

PIPELINE
--------
  1. Dependency check — ensure yfinance and requests are installed; install
     from requirements.txt if missing.

  2. First-run bootstrap — copy sources.json and schedule.json from the skill
     directory into $FACTORY if they do not yet exist.

  3. Adapter refresh (catalog.py) — run all adapters:
       - Non-FMP adapters: parallel threads (no shared quota)
       - FMP adapters: sequential with daily budget guard (counter file)
     Output: series CSV files, news raw.json files, updated catalog.json.

  4. News digest processing (process_news.py) — for each news source whose
     raw.json was just updated, run the normalise → deduplicate → rank
     → mark_new pipeline and write digest.json.

  5. News brief synthesis (magi-tool research) — for each digest that has
     new items, invoke the Research tool via the Tool API to fetch full-text
     of new articles and produce/update brief.md.
     Skipped if MAGI_TOOL_TOKEN is not set (i.e. running outside the daemon).

  6. Catalog summary — print catalog.py list so the agent (or operator) can
     see the outcome at a glance.

DESIGN NOTES
------------
Steps 3 and 4 use direct Python imports (catalog.cmd_refresh, process_news.process)
rather than subprocess calls.  This avoids spawning extra Python interpreters,
preserves full tracebacks, and keeps all paths as pathlib.Path objects rather
than fragile shell string interpolation.

Step 5 uses subprocess to call magi-tool (a Node.js CLI), which is the correct
boundary: magi-tool is a compiled TypeScript binary that calls the Tool API
server; it cannot be imported as a Python module.

All output is written to stdout and simultaneously appended to refresh.log via
the _Log context manager.

USAGE
-----
  python3 refresh.py <SHARED_DIR>

Environment (injected by daemon when run as a background job):
  MAGI_TOOL_URL   — Tool API endpoint (default: http://localhost:4001)
  MAGI_TOOL_TOKEN — Session bearer token (required for brief synthesis)
"""

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

def _resolve_paths(shared_dir: str) -> tuple[Path, Path, Path, Path]:
    """
    Compute the four key directories from the shared_dir argument.

    Returns (factory, skill_dir, sources_path, schedule_path).

    factory   = $SHARED_DIR/data-factory    — live data files
    skill_dir = the parent of this script   — bundled defaults (sources.json, etc.)
    """
    factory   = Path(shared_dir) / "data-factory"
    skill_dir = Path(__file__).parent.parent   # scripts/ → data-factory/
    sources_path  = factory / "sources.json"
    schedule_path = factory / "schedule.json"
    return factory, skill_dir, sources_path, schedule_path


# ---------------------------------------------------------------------------
# Tee logger: writes to stdout and appends to refresh.log simultaneously
# ---------------------------------------------------------------------------

class _Log:
    """
    Context manager that duplicates all log() calls to stdout and refresh.log.

    Usage:
        with _Log(factory / "refresh.log") as log:
            log("message")

    Log write failures are silently ignored so a permissions error on the log
    file never aborts the refresh.
    """

    def __init__(self, log_path: Path) -> None:
        self._path = log_path
        self._file = None

    def __enter__(self) -> "_Log":
        try:
            self._file = open(self._path, "a")
        except OSError:
            pass
        return self

    def __exit__(self, *_) -> None:
        if self._file:
            try:
                self._file.close()
            except OSError:
                pass

    def __call__(self, msg: str) -> None:
        """Print msg to stdout and append to the log file."""
        print(msg, flush=True)
        if self._file:
            try:
                self._file.write(msg + "\n")
                self._file.flush()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Step 1 — Dependency check
# ---------------------------------------------------------------------------

def ensure_deps(skill_dir: Path, log: _Log) -> None:
    """
    Verify that required Python packages are importable; install if missing.

    Checks for the two packages most likely to be absent on a fresh agent
    environment: requests (used by several adapters) and yfinance (the Yahoo
    Finance client).  If either is missing, installs everything from
    requirements.txt using the current interpreter's pip.

    This is intentionally a best-effort check: if pip is unavailable (unusual
    but possible in some container configurations) we log a warning and
    continue — some adapters may still work without all packages.
    """
    missing = []
    for pkg in ("requests", "yfinance"):
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)

    if not missing:
        return

    log(f"[refresh] Missing packages: {missing}. Installing from requirements.txt ...")
    req_file = skill_dir / "requirements.txt"
    if not req_file.exists():
        log(f"[refresh] WARNING: requirements.txt not found at {req_file}, skipping install")
        return

    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", "-r", str(req_file)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        log(f"[refresh] WARNING: pip install failed: {result.stderr.strip()[:200]}")
    else:
        log("[refresh] Dependencies installed.")


# ---------------------------------------------------------------------------
# Step 2 — First-run bootstrap
# ---------------------------------------------------------------------------

def bootstrap_config(factory: Path, skill_dir: Path,
                     sources_path: Path, schedule_path: Path,
                     log: _Log) -> None:
    """
    Copy default sources.json and schedule.json into $FACTORY on first run.

    The bundled files in the skill directory are templates; agents are expected
    to customise $FACTORY/sources.json to add or remove sources.  We never
    overwrite an existing file — the agent's customisations take precedence.
    """
    factory.mkdir(parents=True, exist_ok=True)

    for dest, src_name in [(sources_path, "sources.json"), (schedule_path, "schedule.json")]:
        if not dest.exists():
            src = skill_dir / src_name
            if src.exists():
                shutil.copy(src, dest)
                log(f"[refresh] Copied default {src_name} → {dest}")
            else:
                log(f"[refresh] WARNING: default {src_name} not found at {src}")


# ---------------------------------------------------------------------------
# Step 3 — Adapter refresh via catalog.py
# ---------------------------------------------------------------------------

def run_adapters(factory: Path, sources_path: Path, schedule_path: Path,
                 log: _Log) -> None:
    """
    Invoke catalog.cmd_refresh to run all configured adapters.

    Reads fmp_daily_budget from schedule.json (default 200) and passes it to
    cmd_refresh so the FMP budget guard uses the operator-configured limit
    rather than the hardcoded default.

    The FMP counter file is $FACTORY/.fmp_usage_YYYY-MM-DD (one per day).
    catalog.cmd_refresh handles the parallel/sequential split internally.
    """
    # Import here (not at module top) so the rest of refresh.py can run even
    # if catalog.py has a syntax error — failure is isolated to this step.
    import catalog

    schedule: dict = {}
    if schedule_path.exists():
        try:
            schedule = json.loads(schedule_path.read_text())
        except json.JSONDecodeError:
            log("[refresh] WARNING: schedule.json is malformed, using defaults")

    fmp_budget = int(schedule.get("fmp_daily_budget", 200))
    from datetime import date
    fmp_budget_file = str(factory / f".fmp_usage_{date.today().isoformat()}")
    log_path = str(factory / "refresh.log")

    log(f"[refresh] Running adapters (FMP budget: {fmp_budget}/day) ...")
    catalog.cmd_refresh(
        factory_dir=str(factory),
        sources_file=str(sources_path),
        fmp_budget_file=fmp_budget_file,
        fmp_budget=fmp_budget,
        log_file=log_path,
    )
    log("[refresh] Adapter refresh complete.")


# ---------------------------------------------------------------------------
# Step 4 — News digest processing via process_news.py
# ---------------------------------------------------------------------------

def process_news_digests(factory: Path, sources_path: Path, log: _Log) -> None:
    """
    For each news source, run the full normalise→deduplicate→rank→mark_new pipeline.

    Reads the list of news sources from sources.json and for each one:
    - Checks that the adapter wrote raw.json (skips if missing — adapter may
      have failed or been skipped due to budget)
    - Calls process_news.process() directly (no subprocess) with the raw file
      and the existing digest as inputs

    The updated digest.json is written in-place, preserving the is_new flags
    that step 5 uses to decide which articles need LLM synthesis.
    """
    import process_news  # import here for the same isolation reason as catalog

    if not sources_path.exists():
        log("[refresh] sources.json not found — skipping news digest processing")
        return

    sources = json.loads(sources_path.read_text())

    for news_src in sources.get("news", []):
        src_id   = news_src["id"]
        out_dir  = factory / news_src["output_dir"]
        raw_json = out_dir / "raw.json"
        digest   = out_dir / "digest.json"

        if not raw_json.exists():
            log(f"[process_news] Skipping {src_id}: raw.json not found")
            continue

        log(f"[process_news] Processing {src_id} ...")
        try:
            process_news.process(
                raw_path=str(raw_json),
                existing_path=str(digest),   # process() handles missing file gracefully
                output_path=str(digest),
            )
        except Exception as exc:
            log(f"[process_news] ERROR {src_id}: {exc}")


# ---------------------------------------------------------------------------
# Step 5 — News brief synthesis via magi-tool research
# ---------------------------------------------------------------------------

def synthesise_briefs(factory: Path, sources_path: Path, log: _Log) -> None:
    """
    For each digest with new items, call magi-tool research to update brief.md.

    This step requires MAGI_TOOL_TOKEN to be set in the environment, which the
    daemon injects when it spawns the refresh script as a background job.  If
    the token is absent the step is skipped with a clear message — allowing
    manual refresh runs (without the daemon) to complete the data pipeline up
    to but not including the LLM synthesis step.

    For each qualifying news source:
    - Reads the digest to count new items (skips sources with no new articles)
    - Builds the magi-tool research command with digest.json and brief.md as
      context files; brief.md is omitted if it does not yet exist (first run)
    - Calls magi-tool as a subprocess (it is a Node.js binary, not importable)
    - Writes the synthesised brief to brief.md via --output
    """
    if not os.environ.get("MAGI_TOOL_TOKEN"):
        log("[refresh] MAGI_TOOL_TOKEN not set — skipping brief synthesis "
            "(run as a daemon background job to enable)")
        return

    if not sources_path.exists():
        return

    sources  = json.loads(sources_path.read_text())
    schedule: dict = {}
    schedule_path = factory / "schedule.json"
    if schedule_path.exists():
        try:
            schedule = json.loads(schedule_path.read_text())
        except json.JSONDecodeError:
            pass

    max_fetch = int(schedule.get("news_max_articles_fetch", 5))
    log("[refresh] Updating news briefs via Research tool ...")

    for news_src in sources.get("news", []):
        src_id     = news_src["id"]
        out_dir    = factory / news_src["output_dir"]
        digest_path = out_dir / "digest.json"
        brief_path  = out_dir / "brief.md"

        if not digest_path.exists():
            log(f"[brief] Skipping {src_id}: digest.json not found")
            continue

        digest = json.loads(digest_path.read_text())
        new_items = [it for it in digest.get("items", []) if it.get("is_new")]
        if not new_items:
            log(f"[brief] No new items for {src_id} — skipping synthesis")
            continue

        log(f"[brief] Synthesising brief for {src_id} ({len(new_items)} new items) ...")

        # Pass digest + previous brief as context; Research will fetch new article URLs
        context_args = ["--context-file", str(digest_path)]
        if brief_path.exists():
            context_args += ["--context-file", str(brief_path)]

        question = (
            f"Update the NVDA news brief based on today's digest. "
            f"Fetch up to {max_fetch} new articles (use the URLs provided in the digest). "
            f"Preserve the previous brief's structure. "
            f"Highlight what changed since yesterday. "
            f"Include a Sources section with article URLs."
        )

        cmd = [
            "magi-tool", "research",
            "--question", question,
            *context_args,
            "--output", str(brief_path),
            "--max-age-hours", "0",
        ]

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            log(f"[brief] ERROR {src_id}: {result.stderr.strip()[:300]}")
        else:
            log(f"[brief] Updated {brief_path}")


# ---------------------------------------------------------------------------
# Step 6 — Catalog summary
# ---------------------------------------------------------------------------

def print_catalog_summary(factory: Path, log: _Log) -> None:
    """Print the current catalog table so the agent can see the refresh outcome."""
    try:
        import catalog
        log("[refresh] Current catalog:")
        catalog.cmd_list(str(factory), as_json=False)
    except Exception as exc:
        log(f"[refresh] WARNING: could not print catalog: {exc}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: python3 refresh.py <SHARED_DIR>", file=sys.stderr)
        sys.exit(1)

    shared_dir = sys.argv[1]
    factory, skill_dir, sources_path, schedule_path = _resolve_paths(shared_dir)

    # Add the scripts directory to sys.path so we can import catalog and process_news
    scripts_dir = Path(__file__).parent
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))

    factory.mkdir(parents=True, exist_ok=True)
    log_path = factory / "refresh.log"

    with _Log(log_path) as log:
        ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
        log(f"\n=== refresh.py {ts} ===")

        try:
            ensure_deps(skill_dir, log)
            bootstrap_config(factory, skill_dir, sources_path, schedule_path, log)
            run_adapters(factory, sources_path, schedule_path, log)
            process_news_digests(factory, sources_path, log)
            synthesise_briefs(factory, sources_path, log)
            print_catalog_summary(factory, log)
        except Exception as exc:
            log(f"[refresh] FATAL: {exc}")
            raise

        ts_done = datetime.now(timezone.utc).isoformat(timespec="seconds")
        log(f"=== refresh.py done {ts_done} ===")


if __name__ == "__main__":
    main()
