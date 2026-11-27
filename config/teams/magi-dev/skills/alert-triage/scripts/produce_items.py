#!/usr/bin/env python3
"""produce_items.py — the review items for alert triage: one per open security alert and one per
watched guard, as JSON lines for the review pipeline (review-pipeline/scripts/review.py).

    python3 produce_items.py --reference magi-v3 --out items.jsonl [--alerts alerts.json]

Reads the alerts with the `security-alerts` tool (or from --alerts, a file holding its output),
and the repository from the reference copy: the trace's entry points
(docs/security/entry-points.json) and the watched guards (scripts/security/watched-guards.json),
which go into each item's briefing. Run as a background job; the alerts are private, so keep
--out in your workdir.

Each item carries a `priority` (higher is worked first, review-pipeline/scripts/work_queue.py) and
a `band` for the backlog line: the alert's severity, plus BOUNDARY_BONUS when its file implements
a trust boundary (the threat model's "Implementing Files by Boundary"); a watched guard is GUARD.
"""
import argparse
import json
import os
import re
import sys

REFERENCE_ROOT = "/var/lib/magi/reference"

SEVERITY = {"critical": 40, "high": 30, "error": 30, "medium": 20, "moderate": 20, "warning": 20,
            "low": 10, "note": 10}
BOUNDARY_BONUS = 15
GUARD = 50
BOUNDARY_SECTION = "## Implementing Files by Boundary"


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def fetch_alerts():
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, os.path.join(here, "..", "..", "..", "_platform", "run-background", "scripts"))
    import magi_tool  # noqa: E402 — only when run as a real job

    data = magi_tool.call_tool_timeout("security-alerts", 120, {})
    return json.loads(data["result"]["content"][0]["text"])["alerts"]


def entry_points_in(entries, path):
    return [e for e in entries if e.get("file") == path]


def describe_entries(entries):
    if not entries:
        return "No entry point of the catalog is declared in this file."
    lines = [f"- {e.get('kind')} `{e.get('name')}` (line {e.get('line')}) serves operation `{e.get('tag')}`"
             for e in entries[:15]]
    return "Entry points in this file:\n" + "\n".join(lines)


def boundary_files(tree):
    """Files and folders the threat model lists as implementing a trust boundary."""
    try:
        with open(os.path.join(tree, "docs", "security", "threat-model.md"), encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return []
    start = text.find(BOUNDARY_SECTION)
    if start < 0:
        return []
    end = text.find("\n## ", start + len(BOUNDARY_SECTION))
    section = text[start:end if end > 0 else len(text)]
    return sorted(set(re.findall(r"^- `([^`\s]+)`", section, flags=re.M)))


def on_boundary(path, boundary):
    return bool(path) and any(path == b or (b.endswith("/") and path.startswith(b)) for b in boundary)


def score(severity, path=None, boundary=()):
    sev = str(severity or "").lower()
    priority = SEVERITY.get(sev, 10) + (BOUNDARY_BONUS if on_boundary(path, boundary) else 0)
    return priority, sev or "unknown"


def guard_for(guards, path):
    return next((g for g in guards if g["path"] == path), None)


def code_scanning_item(a, entries, guards, boundary=()):
    path = a.get("path", "")
    priority, band = score(a.get("severity"), path, boundary)
    guard = guard_for(guards, path)
    briefing = [
        f"Alert {a['number']} from {a.get('tool')}: rule `{a.get('rule')}`, severity {a.get('severity')}.",
        f"Location: `{path}` line {a.get('line')}.",
        f"Scanner's message: {a.get('message', '')}",
        describe_entries(entry_points_in(entries, path)),
    ]
    if guard:
        briefing.append(f"This file is a watched guard ({guard['invariant']}, {guard['boundary']}): {guard['why']} "
                        f"Tests that attack it: {', '.join(guard['tests'])}.")
    return {
        "id": f"cs-{a['number']}",
        "kind": "code-scanning",
        "priority": priority,
        "band": band,
        "facts": {k: a.get(k) for k in ("number", "tool", "rule", "path", "line", "severity")},
        "briefing": "\n\n".join(briefing),
        "deps": {"files": [path] + (guard["tests"] if guard else [])},
    }


def dependabot_item(a):
    manifest = a.get("manifest", "package-lock.json")
    briefing = [
        f"Alert {a['number']}: {a.get('ecosystem')} package `{a.get('package')}`, advisory {a.get('advisory')}"
        + (f" ({a['cve']})" if a.get("cve") else "") + f", severity {a.get('severity')}.",
        f"Vulnerable range: {a.get('vulnerableRange')}; first patched: {a.get('patched') or 'none yet'}.",
        f"Manifest: `{manifest}`.",
        f"Advisory summary: {a.get('summary', '')}",
    ]
    return {
        "id": f"dep-{a['number']}",
        "kind": "dependabot",
        "priority": score(a.get("severity"))[0],
        "band": score(a.get("severity"))[1],
        "facts": {k: a.get(k) for k in ("number", "package", "advisory", "severity")},
        "briefing": "\n\n".join(briefing),
        "deps": {"files": [manifest]},
    }


def guard_item(g, entries):
    briefing = [
        f"Watched guard `{g['path']}`: holds {g['invariant']} on boundary {g['boundary']}.",
        f"Why it matters: {g['why']}",
        f"Tests that attack it: {', '.join(g['tests'])}.",
        describe_entries(entry_points_in(entries, g["path"])),
    ]
    return {
        "id": "guard-" + g["path"].replace("/", "-"),
        "kind": "guard",
        "priority": GUARD,
        "band": "guard",
        "facts": {"path": g["path"], "invariant": g["invariant"]},
        "briefing": "\n\n".join(briefing),
        "deps": {"files": [g["path"], *g["tests"]]},
    }


def produce(alerts, tree, guards_file=None):
    entries = load_json(os.path.join(tree, "docs", "security", "entry-points.json"), [])
    guards_path = guards_file or os.path.join(tree, "scripts", "security", "watched-guards.json")
    guards = load_json(guards_path, {}).get("guards", [])
    boundary = boundary_files(tree)
    items = [guard_item(g, entries) for g in guards]
    for a in alerts:
        if a.get("source") == "code-scanning":
            items.append(code_scanning_item(a, entries, guards, boundary))
        elif a.get("source") == "dependabot":
            items.append(dependabot_item(a))
    return items


def main(argv, reference_root=REFERENCE_ROOT):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--reference", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--alerts", help="a file holding the security-alerts tool's output (otherwise the tool is called)")
    ap.add_argument("--reference-root", default=reference_root, help=argparse.SUPPRESS)
    ap.add_argument("--guards", help=argparse.SUPPRESS)  # another watched-guards list (the benchmark's)
    a = ap.parse_args(argv)
    alerts = load_json(a.alerts, {}).get("alerts", []) if a.alerts else fetch_alerts()
    tree = os.path.join(a.reference_root, a.reference, "current")
    items = produce(alerts, tree, a.guards)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = f"{a.out}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for item in items:
            f.write(json.dumps(item) + "\n")
    os.replace(tmp, a.out)
    counts = {}
    for item in items:
        counts[item["kind"]] = counts.get(item["kind"], 0) + 1
    print(json.dumps({"items": len(items), "byKind": counts}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
