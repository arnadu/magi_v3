#!/usr/bin/env python3
"""Check that every code reference in a report exists in the repository.

A report that names a function, a file, a line or a route the code does not
have is wrong, however plausible it reads. This script finds the references
and looks each one up in your clone:

  - `identifier` (in backticks: camelCase, PascalCase, snake_case, or ending in ())
        appears as a whole word somewhere in the code;
  - `identifier` (file.ts) or `identifier` (file.ts:NN)
        appears in that file;
  - file.ts / path/to/file.ts, with :NN or :NN-MM
        exists, and has that many lines;
  - `GET /some/path` and other routes in backticks
        their last fixed segments appear in a quoted string in the code.

Usage:
  python3 check-citations.py <report.md> <clone>       # exits 1 if anything is not found
  python3 check-citations.py --selftest <clone>        # proves it catches an invented name

It checks existence, not meaning: a real function cited for the wrong
behaviour still passes. Read the code for that.
"""
import os
import re
import sys
import tempfile

CODE_EXT = (".ts", ".tsx", ".js", ".mjs", ".py", ".sh", ".yaml", ".yml", ".json", ".md", ".html")
SKIP_DIRS = {"node_modules", ".git", "dist", "public", "coverage"}
FILE_RE = re.compile(r"(?<![\w/.*-])((?:[\w.-]+/)*[\w][\w.-]*\.(?:tsx|ts|mjs|json|js|py|sh|yaml|yml|md))\b(?::(\d+)(?:-(\d+))?)?")
TICK_RE = re.compile(r"`([^`\n]{2,120})`")
IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\(\))?$")
ROUTE_RE = re.compile(r"^(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(/[\w/:.\-{}]*)$")
PAIR_RE = re.compile(r"`([A-Za-z_][A-Za-z0-9_]*)(?:\(\))?`\s*\(([\w./-]+\.(?:tsx|ts|mjs|js|py))(?::\d+)?\)")


def looks_like_identifier(tok):
    """Names worth checking: not plain lower-case words, which prove nothing either way."""
    name = tok[:-2] if tok.endswith("()") else tok
    if not IDENT_RE.match(tok) or len(name) < 4:
        return False
    return tok.endswith("()") or "_" in name or any(c.isupper() for c in name[1:]) or name[0].isupper()


# Not repository files: placeholders in templates, and the mission's own shared folder
# (reports, skills, work files), which lives outside the clone.
PLACEHOLDER_RE = re.compile(r"YYYY|<|>|^(?:file|report|path/to/file)\.(?:tsx?|md|py)$")
MISSION_PREFIXES = ("reports/", "skills/", "work/", "checklists/", "shared/", "home/")


def is_placeholder_or_mission_path(ref, before):
    if PLACEHOLDER_RE.search(ref) or ref.startswith(MISSION_PREFIXES):
        return True
    return "$" in before[-15:] or "SHARED_DIR" in before or "WORKDIR" in before


def index_clone(clone):
    files, words = {}, set()
    for root, dirs, names in os.walk(clone):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for n in names:
            if not n.endswith(CODE_EXT):
                continue
            p = os.path.join(root, n)
            try:
                text = open(p, encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            rel = os.path.relpath(p, clone)
            files[rel] = text
            words.update(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", text))
    return files, words


def find_files(files, ref):
    while ref.startswith("./"):
        ref = ref[2:]
    if ref in files:
        return [ref]
    return [p for p in files if p == ref or p.endswith("/" + ref)]


def check(report_text, clone):
    files, words = index_clone(clone)
    results = []  # (kind, citation, ok, note)
    seen = set()

    def add(kind, cite, ok, note=""):
        if (kind, cite) in seen:
            return
        seen.add((kind, cite))
        results.append((kind, cite, ok, note))

    for m in PAIR_RE.finditer(report_text):
        name, ref = m.group(1), m.group(2)
        if PLACEHOLDER_RE.search(ref):
            continue
        hits = find_files(files, ref)
        if not hits:
            add("pair", f"{name} ({ref})", False, "file not found")
        elif not any(re.search(rf"\b{re.escape(name)}\b", files[h]) for h in hits):
            add("pair", f"{name} ({ref})", False, "not in that file")
        else:
            add("pair", f"{name} ({ref})", True)

    for m in FILE_RE.finditer(report_text):
        ref, line = m.group(1), m.group(2)
        if "/" not in ref and ref.count(".") < 1:
            continue
        if is_placeholder_or_mission_path(ref, report_text[max(0, m.start() - 20) : m.start()]):
            continue
        hits = find_files(files, ref)
        cite = ref + (f":{line}" if line else "")
        if not hits and "/" not in ref and ref.endswith(".md"):
            continue  # a bare report name: most likely a file in the mission's own folder
        if not hits:
            add("file", cite, False, "file not found")
        elif line and not any(files[h].count("\n") + 1 >= int(line) for h in hits):
            add("file", cite, False, "file is shorter than that line")
        else:
            add("file", cite, True)

    for m in TICK_RE.finditer(report_text):
        tok = m.group(1).strip()
        r = ROUTE_RE.match(tok)
        if r and tok.count("/") >= 1 and len(tok) > 2:
            segs = [s for s in r.group(2).split("/") if s and not s.startswith(":") and not s.startswith("{")]
            if not segs:
                continue
            tail = "/" + "/".join(segs[-2:]) if len(segs) >= 2 else "/" + segs[-1]
            last = "/" + segs[-1]
            ok = any(
                re.search(r"[\"'`][^\"'`\n]*" + re.escape(t) + r"[\"'`/]", text)
                for text in files.values()
                for t in (tail, last)
            )
            add("route", tok, ok, "" if ok else "no such path in the code")
        elif looks_like_identifier(tok):
            name = tok[:-2] if tok.endswith("()") else tok
            add("name", tok, name in words, "" if name in words else "appears nowhere in the code")
    return results


def report(results):
    bad = [r for r in results if not r[2]]
    for kind, cite, _, note in bad:
        print(f"NOT FOUND  {kind:5}  {cite}  — {note}")
    print(f"\n{len(results)} citations checked: {len(results) - len(bad)} found, {len(bad)} not found")
    return 1 if bad else 0


def selftest(clone):
    real = "check-citations.py" if find_files(index_clone(clone)[0], "check-citations.py") else None
    if not real:
        print("selftest: run it with your clone of the repository")
        return 1
    # Built at run time: written literally, they would be found in this very script.
    fake1, fake2 = "invented" + "FunctionXyz", "madeUp" + "HelperQq"
    text = f"Uses `looks_like_identifier` (check-citations.py) and `{fake1}` (check-citations.py), and `{fake2}`."
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write(text)
    res = check(open(f.name).read(), clone)
    os.unlink(f.name)
    bad = {r[1] for r in res if not r[2]}
    expect = {f"{fake1} (check-citations.py)", fake2}
    good = "looks_like_identifier (check-citations.py)" not in bad and expect <= bad
    print("selftest:", "caught the invented names and passed the real one" if good else f"FAILED: {bad}")
    return 0 if good else 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--selftest":
        sys.exit(selftest(sys.argv[2]))
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    sys.exit(report(check(open(sys.argv[1], encoding="utf-8").read(), sys.argv[2])))
