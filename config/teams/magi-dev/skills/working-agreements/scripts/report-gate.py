#!/usr/bin/env python3
"""The report gate: every new or changed report is checked by code before it counts.

Agents skipped the checks they were asked to run on their own reports, and reports with
invented commits, tests and code were filed as verified. This job runs the citation
checker over each report in `reports/<area>/` whose content changed since the gate last
saw it, records the result in `reports/gate/ledger.md`, and sends each failing report back
to its author with the references that do not exist. A report counts only once it passes.

Usage (the job passes both): report-gate.py <shared dir> <clone> [--since YYYY-MM-DD]
  --since   gate only reports dated on or after this day (default: the day of the first run,
            so the backlog of older reports is not re-litigated)
"""
import datetime
import hashlib
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AREA_OWNER = {"security": "appsec", "code-review": "code-reviewer", "docs": "documenter", "qa": "qa-lead"}
DATED = re.compile(r"^(\d{4}-\d{2}-\d{2})")
MAX_LISTED = 30


def load_checker():
    spec = importlib.util.spec_from_file_location("check_citations", os.path.join(HERE, "check-citations.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def post(shared, to, subject, body):
    """Mail the author through the Tool API; printed instead when run by hand."""
    if not os.environ.get("MAGI_TOOL_TOKEN"):
        print(f"[report-gate] (not sent, no tool token) to {to}: {subject}")
        return
    sys.path.insert(0, os.path.join(shared, "skills", "_platform", "run-background", "scripts"))
    try:
        import magi_tool  # noqa: E402

        magi_tool.post_message(to, subject, body)
    except Exception as e:  # the ledger still records the result
        print(f"[report-gate] could not message {to} about {subject!r}: {e}", file=sys.stderr)


def reports(shared, since):
    root = os.path.join(shared, "reports")
    for area in sorted(AREA_OWNER):
        d = os.path.join(root, area)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            m = DATED.match(name)
            if name.endswith(".md") and m and m.group(1) >= since:
                yield area, name, os.path.join(d, name)


def write_ledger(gate_dir, state):
    rows = sorted(state["reports"].items(), key=lambda kv: kv[1]["gated_at"], reverse=True)
    out = [
        "# Report gate ledger",
        "",
        "Every report since the gate began, as last checked by `report-gate.py` (code, not an agent).",
        "A report counts only when its status is `accepted`. Written by the gate job; do not edit.",
        "",
        "| Report | Author | Checked at | References | Not found | Warnings | Status |",
        "|---|---|---|---|---|---|---|",
    ]
    for path, r in rows:
        out.append(
            f"| {path} | {r['author']} | {r['gated_at']} | {r['checked']} | {r['not_found']} | {r['warnings']} | {r['status']} |"
        )
    tmp = os.path.join(gate_dir, ".ledger.md.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    os.replace(tmp, os.path.join(gate_dir, "ledger.md"))


def main(argv):
    if len(argv) < 3:
        sys.exit(__doc__)
    shared, clone = argv[1], argv[2]
    gate_dir = os.path.join(shared, "reports", "gate")
    os.makedirs(gate_dir, exist_ok=True)
    state_path = os.path.join(gate_dir, "state.json")
    try:
        state = json.load(open(state_path, encoding="utf-8"))
    except (OSError, ValueError):
        state = {"since": datetime.date.today().isoformat(), "reports": {}}
    if "--since" in argv:
        state["since"] = argv[argv.index("--since") + 1]

    checker = load_checker()
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    gated = 0
    for area, name, path in reports(shared, state["since"]):
        text = open(path, encoding="utf-8").read()
        digest = hashlib.sha256(text.encode()).hexdigest()
        key = f"{area}/{name}"
        if state["reports"].get(key, {}).get("sha") == digest:
            continue
        results = checker.check(text, clone)
        bad = [r for r in results if not r[2] and r[0] not in checker.WARN_KINDS]
        warn = [r for r in results if not r[2] and r[0] in checker.WARN_KINDS]
        status = "accepted" if not bad else "rejected"
        state["reports"][key] = {
            "sha": digest,
            "author": AREA_OWNER[area],
            "gated_at": now,
            "checked": len(results),
            "not_found": len(bad),
            "warnings": len(warn),
            "status": status,
        }
        gated += 1
        print(f"[report-gate] {key}: {status} ({len(results)} references, {len(bad)} not found, {len(warn)} warnings)")
        if bad:
            listed = "\n".join(f"- {kind}: {cite} — {note}" for kind, cite, _, note in bad[:MAX_LISTED])
            more = f"\n- … and {len(bad) - MAX_LISTED} more" if len(bad) > MAX_LISTED else ""
            post(
                shared,
                AREA_OWNER[area],
                f"Report not accepted: {key}",
                f"The report gate checked `reports/{key}` against the repository and could not find "
                f"{len(bad)} of its {len(results)} references:\n\n{listed}{more}\n\n"
                "Each one is a commit, test, name, file, id or quoted code that the repository does not have. "
                "Look each up, then correct it or remove the claim that rests on it; do not re-word around it. "
                "The gate checks the report again on its next run, and it counts only once it passes "
                "(`reports/gate/ledger.md`).",
            )
    tmp = state_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, state_path)
    write_ledger(gate_dir, state)
    print(f"[report-gate] {gated} report(s) checked since the last run; ledger: {gate_dir}/ledger.md")


if __name__ == "__main__":
    main(sys.argv)
