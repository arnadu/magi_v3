#!/usr/bin/env python3
"""publish_status.py — after a triage run, publish the triage's counts for the rest of the team.

    publish_status.py <state-dir> <items.jsonl> <register.md> <out.json>

Writes <out.json> (normally `$SHARED_DIR/status/alert-triage.json`): the newest run's stamp,
commit and backlog, and the pipeline's findings still waiting for the agent's verification,
counted by band with the oldest. A finding counts as verified once its item id appears in the
findings register (the register records the item id of every finding it takes in or dismisses).

Counts, item ids and times only: never an alert's content, a verdict or an answer, which stay
in the private state directory.
"""
import json
import os
import re
import sys
import time


def _read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _stamp_iso(stamp):
    """20261128T010050Z → 2026-11-28T01:00:50Z."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.strptime(stamp, "%Y%m%dT%H%M%SZ"))


def run_stamps(runs_dir):
    names = sorted(os.listdir(runs_dir)) if os.path.isdir(runs_dir) else []
    return [n for n in names if re.fullmatch(r"\d{8}T\d{6}Z", n)]


def bands(items_path):
    out = {}
    try:
        with open(items_path, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    item = json.loads(line)
                    out[item["id"]] = str(item.get("band", "unbanded"))
    except OSError:
        pass
    return out


def mentions(text, item_id):
    """`cs-4` is mentioned by "cs-4," but not by "cs-41"."""
    return re.search(r"(?<![\w.-])" + re.escape(item_id) + r"(?![\w-])", text) is not None


def awaiting_verification(state_dir, register_text, band_of):
    """Findings of every run whose item id the register does not mention, each with the run
    that first produced it."""
    runs_dir = os.path.join(state_dir, "runs")
    first_run = {}
    for stamp in run_stamps(runs_dir):
        for f in _read_json(os.path.join(runs_dir, stamp, "findings.json"), []):
            first_run.setdefault(f.get("item_id"), stamp)
    waiting = [{"id": i, "band": band_of.get(i, "unbanded"), "since": _stamp_iso(s)}
               for i, s in first_run.items() if i and not mentions(register_text, i)]
    by_band = {}
    for w in waiting:
        b = by_band.setdefault(w["band"], {"count": 0, "oldestSince": w["since"]})
        b["count"] += 1
        b["oldestSince"] = min(b["oldestSince"], w["since"])
    return {"count": len(waiting), "byBand": by_band, "items": sorted(waiting, key=lambda w: w["since"])}


def status(state_dir, items_path, register_text, now):
    runs_dir = os.path.join(state_dir, "runs")
    runs = run_stamps(runs_dir)
    summary = _read_json(os.path.join(runs_dir, runs[-1], "summary.json"), {}) if runs else {}
    return {
        "writtenAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        "run": runs[-1] if runs else None,
        "commit": summary.get("commit"),
        "counts": summary.get("counts", {}),
        "backlog": summary.get("backlog", {}),
        "awaitingVerification": awaiting_verification(state_dir, register_text, bands(items_path)),
    }


def write_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def main(argv):
    state_dir, items_path, register_path, out = argv
    try:
        with open(register_path, encoding="utf-8") as f:
            register_text = f.read()
    except OSError:
        register_text = ""
    data = status(state_dir, items_path, register_text, time.time())
    write_atomic(out, data)
    print(json.dumps({"published": out, "awaitingVerification": data["awaitingVerification"]["count"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
