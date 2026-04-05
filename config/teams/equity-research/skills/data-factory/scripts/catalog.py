#!/usr/bin/env magi-python3
"""
catalog.py — Data factory catalog manager.

PURPOSE
-------
Central registry for all data sources that the data factory fetches. It knows
which adapters to call, where each output file lives, and whether each source
is fresh or stale. Think of it as the Makefile + manifest for the data factory.

TYPICAL CALL FLOW
-----------------
1. Lin (data-scientist agent) runs `refresh.sh`, which calls:
       catalog.py refresh $FACTORY sources.json
   This iterates every entry in sources.json, spawns the matching adapter
   script, and writes (or updates) the catalog entry in catalog.json.

2. Alex / Marco / Sam read the catalog before each research cycle:
       catalog.py list $FACTORY
   They skip Research/SearchWeb for any series whose status is "ok"
   (not stale, not error) and read the CSV / JSON file directly instead.

3. A single entry can be inspected with:
       catalog.py show $FACTORY <id>

FOLDER LAYOUT ($FACTORY = $SHARED_DIR/data-factory)
----------------------------------------------------
$FACTORY/
  catalog.json                      ← written by this script
  refresh.log                       ← append-only run log
  .fmp_usage_YYYY-MM-DD             ← FMP API call counter (one file per day)
  series/
    yfinance/NVDA_daily.csv         ← OHLCV: date,open,high,low,close,volume
    yfinance/SMH_daily.csv
    fred/DFF.csv                    ← FRED series: date,value
    fred/T10Y2Y.csv
    fmp/NVDA_filings.json           ← SEC filing index: [{type, date, url}]
  news/
    nvda_competitive_landscape/
      raw.json                      ← adapter output (list of articles)
      digest.json                   ← process_news.py output
      brief.md                      ← LLM-synthesised brief (Research tool)
  documents/                        ← reserved for future document downloads

DATA MODEL
----------
catalog.json is a JSON array of catalog entries:

  [
    {
      "id":         "yfinance/NVDA_daily",   # unique source identifier
      "type":       "series" | "news",       # series = CSV; news = JSON digest
      "adapter":    "yfinance",              # matches adapter_<name>.py
      "schedule":   "daily" | "weekly" | "monthly",
      "output":     "series/yfinance/NVDA_daily.csv",  # relative to $FACTORY
      "status":     "ok" | "error" | "stale" | "skipped",
      "fetched_at": "2026-04-04T05:30:00+00:00",
      "rows":       252,                     # CSV rows (series only; omitted for news)
      "error":      null | "error message"   # null when status = ok
    },
    ...
  ]

sources.json (the input to `refresh`) has three sections:

  {
    "series":    [ { "id", "adapter", "params", "schedule", "output" }, ... ],
    "news":      [ { "id", "adapter", "params", "schedule", "output_dir" }, ... ],
    "documents": [ { "id", "adapter", "params", "schedule", "output" }, ... ]
  }

USAGE
-----
  python3 catalog.py list    <factory_dir> [--json]
  python3 catalog.py show    <factory_dir> <id>
  python3 catalog.py refresh <factory_dir> <sources_json>
                             [--fmp-budget-file FILE] [--fmp-budget N] [--log FILE]
"""

import argparse
import json
import os
import subprocess
import sys
import threading
from datetime import date, datetime, timezone
from pathlib import Path


CATALOG_FILE = "catalog.json"

# Default daily call budget for FMP (free tier = 250; we guard at 200 to leave
# headroom for ad-hoc agent calls).
DEFAULT_FMP_BUDGET = 200


# ---------------------------------------------------------------------------
# Catalog I/O
# ---------------------------------------------------------------------------

def load_catalog(factory_dir: str) -> list:
    """
    Load the catalog from $FACTORY/catalog.json.

    Returns an empty list if the file does not yet exist (first run).
    The returned list is mutable — callers typically mutate it and pass it
    back to save_catalog().
    """
    path = Path(factory_dir) / CATALOG_FILE
    if not path.exists():
        return []
    return json.loads(path.read_text())


def save_catalog(factory_dir: str, entries: list) -> None:
    """Persist the catalog list to $FACTORY/catalog.json (pretty-printed)."""
    path = Path(factory_dir) / CATALOG_FILE
    path.write_text(json.dumps(entries, indent=2, default=str))


def upsert_entry(entries: list, entry: dict) -> list:
    """
    Insert or replace a catalog entry matched by its 'id' field.

    If an entry with the same id already exists it is replaced in-place;
    otherwise the new entry is appended. Returns the (mutated) list.
    """
    for i, e in enumerate(entries):
        if e["id"] == entry["id"]:
            entries[i] = entry
            return entries
    entries.append(entry)
    return entries


# ---------------------------------------------------------------------------
# Staleness detection
# ---------------------------------------------------------------------------

# How many calendar days before a successfully-fetched entry is considered stale.
STALE_THRESHOLDS = {
    "daily":   1,   # stale if fetched on a previous calendar day
    "weekly":  7,
    "monthly": 31,
}


def is_stale(entry: dict) -> bool:
    """
    Return True if the entry's data is older than its schedule allows.

    An entry with no fetched_at timestamp is always considered stale.
    An unknown schedule value defaults to "daily" (strictest threshold).
    """
    fetched_at = entry.get("fetched_at")
    if not fetched_at:
        return True
    schedule = entry.get("schedule", "daily")
    threshold_days = STALE_THRESHOLDS.get(schedule, 1)
    try:
        fetched_date = datetime.fromisoformat(fetched_at).date()
    except (ValueError, TypeError):
        return True
    delta = (date.today() - fetched_date).days
    return delta >= threshold_days


# ---------------------------------------------------------------------------
# CLI commands
# ---------------------------------------------------------------------------

def cmd_list(factory_dir: str, as_json: bool) -> None:
    """
    Print all catalog entries as a human-readable table (default) or JSON array.

    Entries whose status is "ok" but whose data is older than the schedule
    threshold are dynamically relabelled "stale" in the output.
    Does NOT mutate catalog.json — staleness is only a display annotation.
    """
    entries = load_catalog(factory_dir)

    # Apply staleness annotation in memory only
    for e in entries:
        if e.get("status") == "ok" and is_stale(e):
            e["status"] = "stale"

    if as_json:
        print(json.dumps(entries, indent=2, default=str))
        return

    if not entries:
        print("(no entries)")
        return

    fmt = "{:<40} {:<8} {:<10} {:<24} {}"
    print(fmt.format("ID", "TYPE", "STATUS", "FETCHED_AT", "PATH/ERROR"))
    print("-" * 110)
    for e in entries:
        path_or_err = e.get("error") or e.get("output", e.get("output_dir", ""))
        fetched = e.get("fetched_at", "")[:19] if e.get("fetched_at") else "-"
        print(fmt.format(
            e["id"][:40],
            e.get("type", "")[:8],
            e.get("status", "")[:10],
            fetched,
            str(path_or_err)[:60],
        ))


def cmd_show(factory_dir: str, entry_id: str) -> None:
    """
    Print a single catalog entry as JSON, identified by its id.

    Exits with code 1 if the id is not found.
    """
    entries = load_catalog(factory_dir)
    for e in entries:
        if e["id"] == entry_id:
            if e.get("status") == "ok" and is_stale(e):
                e["status"] = "stale"
            print(json.dumps(e, indent=2, default=str))
            return
    print(f"Entry '{entry_id}' not found", file=sys.stderr)
    sys.exit(1)


def cmd_refresh(
    factory_dir: str,
    sources_file: str,
    fmp_budget_file: str | None,
    fmp_budget: int,
    log_file: str | None,
) -> None:
    """
    Run all adapters listed in sources.json and update catalog.json.

    Execution strategy:
    - Non-FMP adapters are run in parallel threads (they are I/O-bound and
      have no shared API quota).
    - FMP adapters are run sequentially after the parallel group finishes.
      Each call first checks the daily counter file; if the budget is already
      exhausted the entry is marked "skipped" and the adapter is not called.

    The catalog is saved once at the end, so a crash mid-refresh will leave
    catalog.json from the previous run intact.
    """
    factory = Path(factory_dir)
    factory.mkdir(parents=True, exist_ok=True)

    sources = json.loads(Path(sources_file).read_text())
    entries = load_catalog(factory_dir)

    log_path = Path(log_file) if log_file else factory / "refresh.log"
    script_dir = Path(__file__).parent

    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    _log(log_path, f"\n=== refresh {ts} ===")

    # FMP budget counter — one plain-text integer file per calendar day.
    # Using a file (not memory) so the counter survives process restarts and
    # is visible to operators via `cat $FACTORY/.fmp_usage_YYYY-MM-DD`.
    budget_file = Path(fmp_budget_file) if fmp_budget_file else \
        factory / f".fmp_usage_{date.today().isoformat()}"

    def fmp_calls() -> int:
        """Read the current FMP call count from the counter file."""
        try:
            return int(budget_file.read_text().strip())
        except (FileNotFoundError, ValueError):
            return 0

    def fmp_inc():
        """Increment the FMP call counter before each adapter invocation."""
        budget_file.write_text(str(fmp_calls() + 1))

    def fmp_ok() -> bool:
        """Return True if we are still within the daily FMP budget."""
        return fmp_calls() < fmp_budget

    # Split sources into FMP (sequential, budget-gated) and everything else
    # (parallel, no quota concerns).
    all_sources = sources.get("series", []) + sources.get("news", [])
    fmp_sources   = [s for s in all_sources if s.get("adapter") == "fmp"]
    other_sources = [s for s in all_sources if s.get("adapter") != "fmp"]

    # --- Parallel phase: non-FMP adapters ---
    # A shared dict collects results; a lock protects concurrent writes.
    results: dict[str, dict] = {}
    results_lock = threading.Lock()

    def run_source(source: dict) -> None:
        entry = _run_adapter(factory, script_dir, source, log_path)
        with results_lock:
            results[source["id"]] = entry

    threads = [threading.Thread(target=run_source, args=(s,), daemon=True)
               for s in other_sources]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # --- Sequential phase: FMP adapters with budget guard ---
    for source in fmp_sources:
        if not fmp_ok():
            msg = (f"[catalog] FMP budget exhausted (≥{fmp_budget} calls today),"
                   f" skipping {source['id']}")
            _log(log_path, msg)
            results[source["id"]] = _make_entry(
                source, "skipped", error="FMP daily budget reached"
            )
            continue
        fmp_inc()
        results[source["id"]] = _run_adapter(factory, script_dir, source, log_path)

    # Merge all results into the existing catalog and persist
    for source_entry in results.values():
        entries = upsert_entry(entries, source_entry)
    save_catalog(factory_dir, entries)

    ok  = sum(1 for e in results.values() if e.get("status") == "ok")
    err = sum(1 for e in results.values() if e.get("status") == "error")
    _log(log_path, f"[catalog] refresh complete — {len(results)} sources processed")
    print(f"[catalog] Refresh complete: {ok} ok, {err} errors. See {log_path}")


# ---------------------------------------------------------------------------
# Adapter execution helpers
# ---------------------------------------------------------------------------

def _safe_output_path(factory: Path, rel: str, source_id: str) -> Path:
    """
    Join *rel* onto *factory* and verify the result stays within *factory*.

    Path traversal guard: sources.json is operator-editable, so an entry like
    ``"output": "../../etc/passwd"`` would otherwise escape the factory dir.
    Using .resolve() to canonicalise before the containment check catches both
    ``..`` segments and symlinks pointing outside.

    Raises ValueError if the resolved path escapes the factory directory.
    """
    candidate = (factory / rel).resolve()
    factory_resolved = factory.resolve()
    if not candidate.is_relative_to(factory_resolved):
        raise ValueError(
            f"Source {source_id!r}: output path {rel!r} escapes factory dir "
            f"({factory_resolved}). Possible path traversal in sources.json."
        )
    return candidate


def _run_adapter(
    factory: Path,
    script_dir: Path,
    source: dict,
    log_path: Path,
) -> dict:
    """
    Invoke one adapter script as a subprocess and return a catalog entry.

    The adapter is called with the standard CLI:
        python3 adapter_<name>.py --fetch <output_path>
                                  --series-id <id>
                                  --params '<json>'

    For news sources the output path is <output_dir>/raw.json; for series
    it is whatever the "output" field specifies.

    Returns a catalog entry dict with status "ok" on success or "error"
    (with the error message captured from stderr) on failure.
    A 120-second per-adapter timeout prevents a hung HTTP call from blocking
    the full refresh.
    """
    adapter = source["adapter"]
    source_id = source["id"]
    adapter_script = script_dir / "adapters" / f"adapter_{adapter}.py"

    if not adapter_script.exists():
        _log(log_path, f"[catalog] ERROR {source_id}: adapter not found: {adapter_script}")
        return _make_entry(source, "error", error=f"adapter not found: {adapter}")

    # Determine whether this is a news or series source and set the output path.
    # _safe_output_path() rejects traversal sequences (e.g. "../../etc") that
    # could otherwise escape the factory directory.
    source_type = "news" if "output_dir" in source else "series"
    try:
        if source_type == "news":
            out_path = _safe_output_path(factory, source["output_dir"], source_id) / "raw.json"
        else:
            out_path = _safe_output_path(factory, source["output"], source_id)
    except ValueError as exc:
        _log(log_path, f"[catalog] ERROR {source_id}: {exc}")
        return _make_entry(source, "error", error=str(exc))
    out_path.parent.mkdir(parents=True, exist_ok=True)

    params_json = json.dumps(source.get("params", {}))
    cmd = [
        sys.executable, str(adapter_script),
        "--fetch",     str(out_path),
        "--series-id", source_id,
        "--params",    params_json,
    ]

    _log(log_path, f"[catalog] running {source_id} ...")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

        if result.returncode != 0:
            err = (result.stderr or result.stdout or "non-zero exit").strip()[:300]
            _log(log_path, f"[catalog] ERROR {source_id}: {err}")
            return _make_entry(source, "error", error=err)

        # Count data rows in CSV outputs so agents can sanity-check the result
        rows = None
        if source_type == "series" and out_path.exists() and out_path.suffix == ".csv":
            with open(out_path) as f:
                rows = sum(1 for line in f) - 1  # subtract the header row

        _log(log_path, f"[catalog] OK {source_id}" + (f" ({rows} rows)" if rows is not None else ""))
        return _make_entry(source, "ok", rows=rows, out_path=out_path)

    except subprocess.TimeoutExpired:
        _log(log_path, f"[catalog] TIMEOUT {source_id}")
        return _make_entry(source, "error", error="timeout after 120s")
    except Exception as exc:
        _log(log_path, f"[catalog] EXCEPTION {source_id}: {exc}")
        return _make_entry(source, "error", error=str(exc))


def _make_entry(
    source: dict,
    status: str,
    error: str | None = None,
    rows: int | None = None,
    out_path: Path | None = None,
) -> dict:
    """
    Build a catalog entry dict from a source definition and a run result.

    The "output" field stores the path relative to $FACTORY so the catalog
    stays portable — absolute paths would break if the factory directory is
    moved. The "rows" field is omitted for news entries (they are JSON, not CSV).
    """
    source_type = "news" if "output_dir" in source else "series"
    entry: dict = {
        "id":         source["id"],
        "type":       source_type,
        "adapter":    source["adapter"],
        "schedule":   source.get("schedule", "daily"),
        "output":     source.get("output", source.get("output_dir", "")),
        "status":     status,
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "error":      error,
    }
    if rows is not None:
        entry["rows"] = rows
    return entry


def _log(log_path: Path, msg: str) -> None:
    """
    Print msg to stdout and append it to the refresh log file.

    Log write failures are silently ignored so a permissions error on the log
    file does not abort the refresh.
    """
    print(msg)
    try:
        with open(log_path, "a") as f:
            f.write(msg + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Data factory catalog manager")
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="List all catalog entries")
    p_list.add_argument("factory_dir")
    p_list.add_argument("--json", action="store_true", dest="as_json",
                        help="Emit JSON array instead of a human-readable table")

    p_show = sub.add_parser("show", help="Show one catalog entry as JSON")
    p_show.add_argument("factory_dir")
    p_show.add_argument("id")

    p_refresh = sub.add_parser("refresh", help="Run all adapters and update catalog.json")
    p_refresh.add_argument("factory_dir")
    p_refresh.add_argument("sources_json",
                           help="Path to sources.json (may be inside or outside $FACTORY)")
    p_refresh.add_argument("--fmp-budget-file", default=None,
                           help="Override path to the FMP daily counter file")
    p_refresh.add_argument("--fmp-budget", type=int, default=DEFAULT_FMP_BUDGET,
                           help=f"Max FMP calls per day (default: {DEFAULT_FMP_BUDGET})")
    p_refresh.add_argument("--log", default=None,
                           help="Override refresh log path (default: $FACTORY/refresh.log)")

    args = parser.parse_args()

    if args.command == "list":
        cmd_list(args.factory_dir, args.as_json)
    elif args.command == "show":
        cmd_show(args.factory_dir, args.id)
    elif args.command == "refresh":
        cmd_refresh(
            args.factory_dir,
            args.sources_json,
            args.fmp_budget_file,
            args.fmp_budget,
            args.log,
        )


if __name__ == "__main__":
    main()
