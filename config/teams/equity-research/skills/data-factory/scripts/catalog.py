#!/usr/bin/env python3
"""
catalog.py - Data factory catalog management.

Usage:
  python3 catalog.py list   <factory_dir> [--json]
  python3 catalog.py show   <factory_dir> <id>
  python3 catalog.py refresh <factory_dir> <sources_json> [--fmp-budget-file F] [--log F]
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


# ---------------------------------------------------------------------------
# Catalog I/O
# ---------------------------------------------------------------------------

def load_catalog(factory_dir: str) -> list:
    path = Path(factory_dir) / CATALOG_FILE
    if not path.exists():
        return []
    return json.loads(path.read_text())


def save_catalog(factory_dir: str, entries: list) -> None:
    path = Path(factory_dir) / CATALOG_FILE
    path.write_text(json.dumps(entries, indent=2, default=str))


def upsert_entry(entries: list, entry: dict) -> list:
    for i, e in enumerate(entries):
        if e["id"] == entry["id"]:
            entries[i] = entry
            return entries
    entries.append(entry)
    return entries


# ---------------------------------------------------------------------------
# Staleness
# ---------------------------------------------------------------------------

STALE_THRESHOLDS = {
    "daily":   1,
    "weekly":  7,
    "monthly": 31,
}


def is_stale(entry: dict) -> bool:
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
# Commands
# ---------------------------------------------------------------------------

def cmd_list(factory_dir: str, as_json: bool) -> None:
    entries = load_catalog(factory_dir)
    # Mark stale entries
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
    log_file: str | None,
) -> None:
    factory = Path(factory_dir)
    factory.mkdir(parents=True, exist_ok=True)

    sources = json.loads(Path(sources_file).read_text())
    entries = load_catalog(factory_dir)

    log_path = Path(log_file) if log_file else factory / "refresh.log"
    script_dir = Path(__file__).parent

    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    _log(log_path, f"\n=== refresh {ts} ===")

    # FMP budget counter
    budget_file = Path(fmp_budget_file) if fmp_budget_file else \
        factory / f".fmp_usage_{date.today().isoformat()}"

    def fmp_calls() -> int:
        try:
            return int(budget_file.read_text().strip())
        except (FileNotFoundError, ValueError):
            return 0

    def fmp_inc():
        budget_file.write_text(str(fmp_calls() + 1))

    def fmp_ok() -> bool:
        return fmp_calls() < 200

    # Separate FMP from non-FMP sources
    all_sources = sources.get("series", []) + sources.get("news", [])
    fmp_sources = [s for s in all_sources if s.get("adapter") == "fmp"]
    other_sources = [s for s in all_sources if s.get("adapter") != "fmp"]

    # Run non-FMP adapters in parallel threads
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

    # Run FMP adapters sequentially with budget guard
    for source in fmp_sources:
        if not fmp_ok():
            msg = f"[catalog] FMP budget exhausted (≥200 calls today), skipping {source['id']}"
            _log(log_path, msg)
            results[source["id"]] = _make_entry(source, "skipped", error="FMP daily budget reached")
            continue
        fmp_inc()
        results[source["id"]] = _run_adapter(factory, script_dir, source, log_path)

    # Merge into catalog
    for source_entry in results.values():
        entries = upsert_entry(entries, source_entry)

    save_catalog(factory_dir, entries)
    _log(log_path, f"[catalog] refresh complete — {len(results)} sources processed")

    ok = sum(1 for e in results.values() if e.get("status") == "ok")
    err = sum(1 for e in results.values() if e.get("status") == "error")
    print(f"[catalog] Refresh complete: {ok} ok, {err} errors. See {log_path}")


# ---------------------------------------------------------------------------
# Adapter execution
# ---------------------------------------------------------------------------

def _run_adapter(
    factory: Path,
    script_dir: Path,
    source: dict,
    log_path: Path,
) -> dict:
    adapter = source["adapter"]
    source_id = source["id"]
    adapter_script = script_dir / "adapters" / f"adapter_{adapter}.py"

    if not adapter_script.exists():
        _log(log_path, f"[catalog] ERROR {source_id}: adapter not found: {adapter_script}")
        return _make_entry(source, "error", error=f"adapter not found: {adapter}")

    # Determine output path
    source_type = "news" if "output_dir" in source else "series"
    if source_type == "news":
        out_path = factory / source["output_dir"] / "raw.json"
    else:
        out_path = factory / source["output"]

    out_path.parent.mkdir(parents=True, exist_ok=True)

    params_json = json.dumps(source.get("params", {}))
    cmd = [
        sys.executable, str(adapter_script),
        "--fetch", str(out_path),
        "--series-id", source_id,
        "--params", params_json,
    ]

    _log(log_path, f"[catalog] running {source_id} ...")
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            err = (result.stderr or result.stdout or "non-zero exit").strip()[:300]
            _log(log_path, f"[catalog] ERROR {source_id}: {err}")
            return _make_entry(source, "error", error=err)

        # Count rows for series CSV
        rows = None
        if source_type == "series" and out_path.exists() and out_path.suffix == ".csv":
            with open(out_path) as f:
                rows = sum(1 for line in f) - 1  # subtract header

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
    source_type = "news" if "output_dir" in source else "series"
    entry = {
        "id": source["id"],
        "type": source_type,
        "adapter": source["adapter"],
        "schedule": source.get("schedule", "daily"),
        "output": source.get("output", source.get("output_dir", "")),
        "status": status,
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "error": error,
    }
    if rows is not None:
        entry["rows"] = rows
    return entry


def _log(log_path: Path, msg: str) -> None:
    print(msg)
    try:
        with open(log_path, "a") as f:
            f.write(msg + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Data factory catalog manager")
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="List all catalog entries")
    p_list.add_argument("factory_dir")
    p_list.add_argument("--json", action="store_true", dest="as_json")

    p_show = sub.add_parser("show", help="Show one catalog entry")
    p_show.add_argument("factory_dir")
    p_show.add_argument("id")

    p_refresh = sub.add_parser("refresh", help="Run all adapters and update catalog")
    p_refresh.add_argument("factory_dir")
    p_refresh.add_argument("sources_json")
    p_refresh.add_argument("--fmp-budget-file", default=None)
    p_refresh.add_argument("--log", default=None)

    args = parser.parse_args()

    if args.command == "list":
        cmd_list(args.factory_dir, args.as_json)
    elif args.command == "show":
        cmd_show(args.factory_dir, args.id)
    elif args.command == "refresh":
        cmd_refresh(args.factory_dir, args.sources_json, args.fmp_budget_file, args.log)


if __name__ == "__main__":
    main()
