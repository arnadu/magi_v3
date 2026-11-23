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
        their last fixed segments appear in a quoted string in the code;
  - "a test's name", in double quotes on a line that names a *.test.ts file
        appears in that test file (a test you cite as evidence must exist);
  - a commit hash (7-12 or 40 hex characters, in backticks, or opening a heading or a
    table row) is a commit of the repository; a subject quoted beside it
    (`fix(scope): ...`) is that commit's subject;
  - catalog ids: TB-n in the threat model, F-nnn in the findings register, sec.* among
    the security invariants, SC-nn in the security controls checklist;
  - a system path (/usr/..., /etc/..., /opt/...) in backticks appears in the code;
  - quoted code: at least half the lines of a code block that follows a line naming a
    file appear in the repository (whitespace ignored). A short backticked snippet on a
    line naming a file is only warned about: paraphrase of real code is common.

A name or quote missing from today's code is also looked for at the commits the report
cites, so a review of code that has since changed is not penalised.

Usage:
  python3 check-citations.py <report.md> <clone>       # exits 1 if anything is not found
  python3 check-citations.py --selftest <clone>        # proves it catches an invented name

It checks existence, not meaning: a real function cited for the wrong
behaviour still passes. Read the code for that.
"""
import os
import re
import subprocess
import sys
import tempfile

CODE_EXT = (".ts", ".tsx", ".js", ".mjs", ".py", ".sh", ".yaml", ".yml", ".json", ".md", ".html")
SKIP_DIRS = {"node_modules", ".git", "dist", "public", "coverage"}
FILE_RE = re.compile(r"(?<![\w/.*-])((?:[\w.-]+/)*(?:[\w][\w.-]*\.(?:tsx|ts|mjs|json|js|py|sh|yaml|yml|md)|Dockerfile))\b(?::(\d+)(?:-(\d+))?)?")
HASH_RE = re.compile(r"(?:`([0-9a-f]{7,12}|[0-9a-f]{40})`|^\s*(?:#+|\|)\s*`?([0-9a-f]{7,12})`?\b|`([0-9a-f]{7,12})\.\.([0-9a-f]{7,12})`)")
SUBJECT_RE = re.compile(r"\b((?:feat|fix|docs|test|tests|chore|refactor|perf|ci|build|style|revert)(?:\([^)]*\))?!?:\s[^|*`\n]{8,})")
CATALOG_RE = re.compile(r"\b(TB-\d+|F-\d{3}|SC-\d{2}|sec\.[a-z][a-z-]+)\b")
CATALOG_HOME = {
    "TB": "docs/security/threat-model.md",
    "F": "docs/security/findings.md",
    "SC": "config/teams/magi-dev/skills/appsec-foundations/checklists/security-controls.md",
    "sec": "packages/agent-config/src/baseline/security-invariants.ts",
}
SYSPATH_RE = re.compile(r"^/(?:usr|etc|opt)/[\w./-]+$")
FENCE_RE = re.compile(r"^```")
TICK_RE = re.compile(r"`([^`\n]{2,120})`")
IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\(\))?$")
ROUTE_RE = re.compile(r"^(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(/[\w/:.\-{}]*)$")
TEST_FILE_RE = re.compile(r"([\w./-]+\.test\.tsx?)")
QUOTE_RE = re.compile(r'"([^"\n]{12,200})"')
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
# Absolute paths on a machine, not in the repository: a worktree, the mission's volume.
SCRATCH_ROOTS = ("/tmp", "/missions", "/home", "/proc", "/var", "/dev")


def is_placeholder_or_mission_path(ref, before):
    if PLACEHOLDER_RE.search(ref) or ref.startswith(MISSION_PREFIXES):
        return True
    return "$" in before[-15:] or "SHARED_DIR" in before or "WORKDIR" in before


def index_clone(clone):
    files, words = {}, set()
    for root, dirs, names in os.walk(clone):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for n in names:
            p = os.path.join(root, n)
            script = "." not in n and (os.path.basename(root) == "scripts" or n.startswith("Dockerfile"))
            if not n.endswith(CODE_EXT) and not script:
                continue
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

    cited = cited_commits(report_text, clone)
    for m in FILE_RE.finditer(report_text):
        ref, line = m.group(1), m.group(2)
        if "/" not in ref and ref.count(".") < 1:
            continue
        after = report_text[m.end() : m.end() + 1]
        if "/" not in ref and (re.fullmatch(r"[A-Z][A-Za-z]*\.js", ref) or after == "("):
            continue  # a product name (Node.js) or a call (express.json()), not a file
        if is_placeholder_or_mission_path(ref, report_text[max(0, m.start() - 20) : m.start()]):
            continue
        hits = find_files(files, ref)
        cite = ref + (f":{line}" if line else "")
        if not hits and "/" not in ref and ref.endswith(".md"):
            continue  # a bare report name: most likely a file in the mission's own folder
        if not hits and "/" not in ref and re.search(r"\b(?:an?|planted|e\.g\.|like)\s+`?$", report_text[max(0, m.start() - 12) : m.start()]):
            continue  # an example ("a planted `json.py`"), not a claim about the repository
        if not hits and ref.endswith(".js"):  # the build output of a TypeScript file
            hits = find_files(files, ref[:-3] + ".ts") or find_files(files, ref.replace("dist/", "src/")[:-3] + ".ts")
        if not hits and at_cited_paths(clone, cited, ref):
            add("file", cite, True)
            continue
        if not hits:
            add("file", cite, False, "file not found")
        elif line and not any(files[h].count("\n") + 1 >= int(line) for h in hits):
            add("file", cite, False, "file is shorter than that line")
        else:
            add("file", cite, True)

    for line in report_text.splitlines():
        test_files = [h for ref in TEST_FILE_RE.findall(line) for h in find_files(files, ref)]
        if not test_files:
            continue
        # A quote can also come from another file the line names (a comment, a doc).
        named = test_files + [h for ref, _, _ in FILE_RE.findall(line) for h in find_files(files, ref)]
        for q in QUOTE_RE.findall(line):
            if q.count(" ") < 2 or q.rstrip().endswith((".", "?", "!")):
                continue  # a word or two, or a quoted sentence, is not a test's name
            # A shortened name that drops a parenthesis is still the same test.
            ok = any(q in files[h] for h in named) or any(
                bare(q) in bare(name) for h in test_files for name in TEST_NAME_RE.findall(files[h])
            )
            add("test", f'"{q}"', ok, "" if ok else "no such test in " + ", ".join(sorted(set(test_files))))

    for m in TICK_RE.finditer(report_text):
        tok = m.group(1).strip()
        if tok.startswith(SCRATCH_ROOTS):
            continue
        if SYSPATH_RE.match(tok):
            ok = any(tok in text for text in files.values())
            add("path", tok, ok, "" if ok else "this path appears nowhere in the code")
            continue
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
            ok = name in words or at_cited_commits(clone, cited, name, word=True)
            line_start = report_text.rfind("\n", 0, m.start()) + 1
            negated = re.search(r"\b(?:no|not|never|without|absent|missing|lacks?)\b[^.\n]{0,40}$",
                                report_text[line_start : m.start()], re.I)
            add("snippet" if (not ok and negated) else "name", tok, ok,
                "" if ok else ("named as absent; check it is a real API" if negated else "appears nowhere in the code"))

    check_commits(report_text, clone, add)
    check_catalog_ids(report_text, files, add)
    check_quoted_code(report_text, files, add)
    return results


# Kinds that are reported but do not make a report fail.
WARN_KINDS = {"snippet"}


def git(clone, *args):
    r = subprocess.run(["git", "-C", clone, *args], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def cited_commits(report_text, clone, limit=6):
    """The report's own commits, newest first: the code it reviewed."""
    found = []
    for line in report_text.splitlines():
        for m in HASH_RE.finditer(line):
            for h in m.groups():
                if h and h not in found and git(clone, "cat-file", "-e", h + "^{commit}") is not None:
                    found.append(h)
    found.sort(key=lambda h: int(git(clone, "log", "-1", "--format=%ct", h) or 0), reverse=True)
    return found[:limit]


_trees = {}


def at_cited_paths(clone, cited, ref):
    """A file a report names that the repository had at some point (a review of older code)."""
    if ref not in _trees:
        _trees[ref] = bool(git(clone, "log", "--all", "-1", "--format=%h", "--", f"*{ref}" if "/" in ref else f"*/{ref}"))
    return _trees[ref]


def at_cited_commits(clone, cited, text, word=False):
    for h in cited:
        args = ["grep", "-q", "-F"] + (["-w"] if word else []) + ["-e", text, h, "--"]
        if git(clone, *args) is not None:
            return True
    return False


def check_commits(report_text, clone, add):
    """Hashes must be commits; a conventional subject beside one must be that commit's."""
    subjects = {}

    def subject(h):
        if h not in subjects:
            subjects[h] = git(clone, "log", "-1", "--format=%s", h + "^{commit}")
        return subjects[h]

    for line in report_text.splitlines():
        hashes = [h for m in HASH_RE.finditer(line) for h in m.groups() if h]
        for h in hashes:
            if not any(c.isdigit() for c in h) or not any(c in "abcdef" for c in h):
                continue  # a word or a number, not a hash
            real = subject(h)
            if real is None:
                add("commit", h, False, "no such commit in the repository")
                continue
            add("commit", h, True)
        if len(hashes) == 1 and subject(hashes[0]):
            m = SUBJECT_RE.search(line)
            if m:
                said = m.group(1).strip().rstrip(".").lower()
                real = subject(hashes[0]).lower()
                n = min(len(said), len(real), 40)
                ok = said[:n] == real[:n]
                add("subject", f"{hashes[0]} {m.group(1).strip()}", ok,
                    "" if ok else f'the commit\'s subject is "{subject(hashes[0])}"')


def check_catalog_ids(report_text, files, add):
    """TB-, F-, SC- and sec.* ids must exist in the documents that define them."""
    homes = {k: files.get(v, "") for k, v in CATALOG_HOME.items()}
    for m in CATALOG_RE.finditer(report_text):
        cid = m.group(1)
        kind = cid.split("-")[0] if "-" in cid and not cid.startswith("sec.") else "sec"
        home = homes.get(kind, "")
        if not home:
            continue
        ok = re.search(rf"(?<![\w.-]){re.escape(cid)}(?![\w-])", home) is not None
        add("id", cid, ok, "" if ok else f"not defined in {CATALOG_HOME[kind]}")


TEST_NAME_RE = re.compile(r"\b(?:it|test|describe)(?:\.\w+)*\(\s*[\"'`](.+?)[\"'`]\s*,")


def bare(text):
    """A test's name without its parentheses and extra spaces."""
    return normalized(re.sub(r"\s*\([^)]*\)", "", text))


def normalized(text):
    return re.sub(r"\s+", " ", text).strip()


def check_quoted_code(report_text, files, add):
    """Code quoted from a file must exist: a block must, a short snippet is only warned about."""
    lines = report_text.splitlines()
    corpus = None

    def single_file(text):
        hits = {h for ref, _, _ in FILE_RE.findall(text) for h in find_files(files, ref)}
        return next(iter(hits)) if len(hits) == 1 else None

    def anywhere(q, src):
        nonlocal corpus
        if q in normalized(files[src]):
            return True
        if corpus is None:
            corpus = normalized("\n".join(files.values()))
        return q in corpus

    i = 0
    while i < len(lines):
        if FENCE_RE.match(lines[i]):
            j = i + 1
            while j < len(lines) and not FENCE_RE.match(lines[j]):
                j += 1
            before = [line for line in lines[max(0, i - 3):i] if line.strip()][-2:]
            src = single_file(" ".join(before))
            first = next((line.strip() for line in lines[i + 1:j] if line.strip()), "")
            proposed = (lines[i].strip("`").strip().lower() in ("gherkin", "text", "diff", "patch")
                        or re.match(r"(?:Given|When|Then|Scenario|Feature)\b", first)
                        or re.search(r"propos|suggest|sketch|would|could|should|new test|add(?:ing|s)? |scenario|e\.g\.",
                                     " ".join(before), re.I))
            if src and not proposed:
                quoted = [normalized(line) for line in lines[i + 1:j]]
                quoted = [q for q in quoted if len(q) >= 8 and "..." not in q and "…" not in q]
                if len(quoted) >= 2:
                    found = sum(anywhere(q, src) for q in quoted)
                    ok = found * 2 >= len(quoted)
                    add("quote", f"code block under line {i + 1} (attributed to {src})", ok,
                        "" if ok else f"{len(quoted) - found} of {len(quoted)} quoted lines are nowhere in the repository")
            i = j + 1
            continue
        src = single_file(lines[i])
        if src:
            for snippet in TICK_RE.findall(lines[i]):
                snippet = snippet.strip().strip('"')
                if (len(snippet) < 15 or " " not in snippet or snippet.startswith(SCRATCH_ROOTS)
                        or ROUTE_RE.match(snippet) or "..." in snippet or "…" in snippet
                        or re.match(r"(?:sh|bash|python3?|node|npx|npm|git|curl|cat|grep|sed|docker|sudo)\s", snippet)):
                    continue
                ok = anywhere(normalized(snippet), src)
                add("snippet", f"`{snippet}` ({src})", ok, "" if ok else "not found verbatim (a paraphrase?)")
        i += 1


def report(results):
    bad = [r for r in results if not r[2] and r[0] not in WARN_KINDS]
    warn = [r for r in results if not r[2] and r[0] in WARN_KINDS]
    for kind, cite, _, note in bad:
        print(f"NOT FOUND  {kind:7}  {cite}  — {note}")
    for kind, cite, _, note in warn:
        print(f"WARNING    {kind:7}  {cite}  — {note}")
    print(f"\n{len(results)} citations checked: {len(results) - len(bad) - len(warn)} found, {len(bad)} not found, {len(warn)} warnings")
    return 1 if bad else 0


def selftest(clone):
    files = index_clone(clone)[0]
    if not find_files(files, "check-citations.py"):
        print("selftest: run it with your clone of the repository")
        return 1
    # A real test and its name, taken from the clone so the selftest outlives any one test.
    real_test = next(
        ((os.path.basename(p), m.group(1)) for p in sorted(files) if p.endswith(".test.ts")
         for m in [re.search(r'\bit\("([^"\n]{12,200})"', files[p])] if m and m.group(1).count(" ") >= 2),
        None,
    )
    if not real_test:
        print("selftest: no test file with a named test in the clone")
        return 1
    test_file, real_name = real_test
    head = git(clone, "rev-parse", "--short=7", "HEAD")
    head_subject = git(clone, "log", "-1", "--format=%s", "HEAD")
    if not head or not head_subject:
        print("selftest: the clone has no commits")
        return 1
    real_tb = (re.search(r"\bTB-\d+\b", files.get(CATALOG_HOME["TB"], "")) or [None])[0]
    # Built at run time: written literally, they would be found in this very script.
    fake1, fake2 = "invented" + "FunctionXyz", "madeUp" + "HelperQq"
    fake3 = "proves " + "a made-up behaviour holds"
    fake_commit = "c0ffee" + "1"
    fake_tb = "TB-" + "987"
    fake_path = "/usr/local/" + "bin/no-such-helper"
    fake_code = ["Cmnd_Alias " + "NOT_A_RULE = /bin/nothing", "%nobody " + "ALL=(root) NOPASSWD: NOT_A_RULE"]
    wrong_subject = "fix(nothing): " + "a subject this commit never had"
    text = (
        f"Uses `looks_like_identifier` (check-citations.py) and `{fake1}` (check-citations.py), and `{fake2}`.\n"
        f'Tested by {test_file}: "{real_name}" and "{fake3}".\n'
        f"### `{head}` — {head_subject}\n"
        f"### `{fake_commit}` — fix(x): nothing\n"
        f"| `{head}` | {wrong_subject} |\n"
        f"Boundaries {real_tb} and {fake_tb}; the helper at `{fake_path}`.\n"
        "check-citations.py installs:\n```\n" + "\n".join(fake_code) + "\n```\n"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write(text)
    res = check(open(f.name).read(), clone)
    os.unlink(f.name)
    bad = {r[1] for r in res if not r[2]}
    expect = {f"{fake1} (check-citations.py)", fake2, f'"{fake3}"', fake_commit, fake_tb, fake_path,
              f"{head} {wrong_subject}"}
    passed = {"looks_like_identifier (check-citations.py)", f'"{real_name}"', head, real_tb}
    quote_caught = any(r[0] == "quote" and not r[2] for r in res)
    good = expect <= bad and not (passed & bad) and quote_caught
    print("selftest:", "caught every invented reference and passed the real ones" if good
          else f"FAILED: missed {expect - bad}, wrongly flagged {passed & bad}, block caught {quote_caught}")
    return 0 if good else 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--selftest":
        sys.exit(selftest(sys.argv[2]))
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    sys.exit(report(check(open(sys.argv[1], encoding="utf-8").read(), sys.argv[2])))
