#!/usr/bin/env python3
"""Build a security work list: every entry point crossed with the controls that apply to it.

Reading code finds what you happen to look at; a work list says what there is to look at, so a
row you skipped stays visible. It joins the trace's entry points (routes, monitor routes, agent
tools, Tool API names, copilot actions, folders agents write requests into, timers) with the
rows of the security controls checklist that apply to that kind of entry point.

Usage:
  python3 worklist.py <analysis-dir> --out <file.md>
        every entry point (a full pass: work through it one kind or component at a time)
  python3 worklist.py <analysis-dir> --out <file.md> --changed <clone> <from>..<to>
        entry points whose own file changed in the range, every control row each; and one row per
        other changed file that entry points reach (shared code: check its change once, for all
        of its callers, rather than once per caller)
  python3 worklist.py <analysis-dir> --out <file.md> --path <prefix>
        only entry points whose file starts with the prefix (one component)

<analysis-dir> is $SHARED_DIR/analysis (the trace's reports, with entry-points.json).
Fill in the result like any checklist and check it with `checklist.py summary`
(working-agreements). Controls that belong to no single entry point (architecture, secrets
inventory, logging, supply chain, deployment) stay in the weekly area rotation of the checklist.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CHECKLIST = os.path.join(HERE, "..", "checklists", "security-controls.md")

# Which controls apply to each kind of entry point. A kind not listed gets DEFAULT and a warning.
CONTROLS_BY_KIND = {
    "route": ["SC-05", "SC-10", "SC-11", "SC-15", "SC-18", "SC-46"],
    "monitor-route": ["SC-05", "SC-11", "SC-15", "SC-16", "SC-46"],
    "tool-api": ["SC-05", "SC-06", "SC-11", "SC-15"],
    "tool": ["SC-15", "SC-16", "SC-17", "SC-20", "SC-30", "SC-32"],
    "copilot-action": ["SC-11", "SC-13", "SC-14", "SC-15"],
    "file-request": ["SC-12", "SC-15", "SC-16", "SC-17"],
    "trigger": ["SC-04", "SC-15"],
}
DEFAULT = ["SC-04", "SC-15"]
REACHED_FILE = re.compile(r"\s(\S+\.(?:ts|tsx|mjs|js|py|sh)):\d+$")


def controls(path):
    rows = {}
    for line in open(path, encoding="utf-8"):
        m = re.match(r"^\|\s*(SC-\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|", line)
        if m:
            rows[m.group(1)] = f"{m.group(2)}: {m.group(3)}"
    return rows


def changed_files(clone, rng):
    out = subprocess.run(
        ["git", "-C", clone, "diff", "--name-only", rng], capture_output=True, text=True, check=True
    ).stdout
    return {l.strip() for l in out.splitlines() if l.strip()}


def files_of(entry):
    files = {entry["file"]}
    for r in entry.get("reached", []):
        m = REACHED_FILE.search(r)
        if m:
            files.add(m.group(1))
    return files


def scan_commit(analysis):
    try:
        m = re.search(r"commit `([0-9a-f]{7,40})`", open(os.path.join(analysis, "index.md"), encoding="utf-8").read())
        return m.group(1) if m else "unknown"
    except OSError:
        return "unknown"


def cell(text):
    return text.replace("|", "\\|").replace("\n", " ")


def main(argv):
    if len(argv) < 4 or argv[2] != "--out":
        sys.exit(__doc__)
    analysis, out, rest = argv[1], argv[3], argv[4:]
    entries = json.load(open(os.path.join(analysis, "entry-points.json"), encoding="utf-8"))
    sc = controls(CHECKLIST)
    scope = "every entry point"
    shared = {}  # changed file reached by entry points that did not change themselves -> callers
    if rest[:1] == ["--changed"] and len(rest) == 3:
        changed = changed_files(rest[1], rest[2])
        for e in entries:
            if e["file"] not in changed:
                for f in files_of(e) & changed:
                    shared.setdefault(f, []).append(e)
        entries = [e for e in entries if e["file"] in changed]
        scope = f"entry points whose own file changed in {rest[2]} ({len(changed)} files changed)"
    elif rest[:1] == ["--path"] and len(rest) == 2:
        entries = [e for e in entries if e["file"].startswith(rest[1])]
        scope = f"entry points under {rest[1]}"
    elif rest:
        sys.exit(__doc__)

    rows, unknown = [], set()
    for e in sorted(entries, key=lambda e: (e["kind"], e["file"], e["line"])):
        ids = CONTROLS_BY_KIND.get(e["kind"])
        if ids is None:
            unknown.add(e["kind"])
            ids = DEFAULT
        where = f"{e['kind']} `{e['name']}` ({e['file']}:{e['line']}), {e.get('tag') or 'untagged'}, actor {e.get('actor') or '?'}"
        for i in ids:
            rows.append((where, f"{i} {sc.get(i, '(not in the checklist)')}"))

    for f, callers in sorted(shared.items(), key=lambda kv: -len(kv[1])):
        kinds = ", ".join(sorted({c["kind"] for c in callers}))
        rows.append((
            f"shared code {f}, reached by {len(callers)} other entry points ({kinds})",
            "Does this change weaken a control for any of its callers? Name the controls the changed lines touch, and the callers you checked",
        ))

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write("# Security work list\n\n")
        f.write(f"Trace of commit `{scan_commit(analysis)}`; {scope}: {len(entries)} entry points, {len(shared)} changed shared files, {len(rows)} rows.\n\n")
        f.write("For each row: does this entry point have this control? Verdicts and evidence as in the\n")
        f.write("security controls checklist; `pass` cites the file:line that implements the control for\n")
        f.write("this entry point, not one like it elsewhere.\n\n")
        f.write("| Id | Entry point | Control | Verdict | Evidence |\n|---|---|---|---|---|\n")
        for n, (where, ctl) in enumerate(rows, 1):
            f.write(f"| WL-{n:04d} | {cell(where)} | {cell(ctl)} | ? | |\n")
    print(f"{len(rows)} rows for {len(entries)} entry points written to {out}")
    if unknown:
        print(f"warning: entry point kinds with no control mapping, given {', '.join(DEFAULT)}: {', '.join(sorted(unknown))}")


if __name__ == "__main__":
    main(sys.argv)
