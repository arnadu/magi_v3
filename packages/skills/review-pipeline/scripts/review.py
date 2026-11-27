#!/usr/bin/env python3
"""review.py — run a list of review items through Investigate, with code deciding what counts.

Security assurance plan, step 6b. Generic: what to review is in the items and the kind
descriptors the mission supplies; this script only orchestrates and checks.

    python3 review.py --items items.jsonl --kinds <dir> --state <dir> --reference <name>
                      [--max-calls 40] [--max-age boundary=14 --max-age platform=30 ...]

For each item, in order:
  1. Due?     skipped when a stored verdict exists, nothing it depended on has changed at the
              reference copy's commit, and it is younger than its risk class's maximum age.
  2. One Investigate run with the kind's skill, schema and question, and the item's briefing.
  3. A candidate finding (the kind's `positive` rule) is confirmed: triage kinds run twice more
     and keep it when two of three agree; discovery kinds keep any candidate. Then the kind's
     refuter tries to disprove it.
  4. Acceptance, by code: every cited file and line exists at the commit and every quote is
     found within three lines of its line; above low severity a reproduction is required.
  5. The verdict is stored with its dependencies (each with its hash at the commit), so the
     next run can tell what changed.

Writes, under --state: verdicts.json (the store), ledger.jsonl (every item examined, appended),
runs/<stamp>/findings.json and summary.json. Prints the summary. Stops starting new
investigations once --max-calls is reached; the items left are recorded as deferred.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time

import work_queue
from dataclasses import dataclass, field

PIPELINE_VERSION = "1"
REFERENCE_ROOT = "/var/lib/magi/reference"
DEFAULT_MAX_AGE_DAYS = {"boundary": 14, "platform": 30, "ordinary": 60}
SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"]
QUOTE_WINDOW = 3


# ── Reference copy ───────────────────────────────────────────────────────────


@dataclass
class Reference:
    name: str
    commit: str
    root: str  # /var/lib/magi/reference/<name>

    @property
    def tree(self) -> str:
        return os.path.join(self.root, "snapshots", self.commit)

    @property
    def git_dir(self) -> str:
        return os.path.join(self.root, "mirror.git")


def load_reference(name: str, reference_root: str = REFERENCE_ROOT) -> Reference:
    root = os.path.join(reference_root, name)
    with open(os.path.join(root, "status.json"), encoding="utf-8") as f:
        commit = json.load(f)["commit"]
    return Reference(name, commit, root)


def file_hash(ref: Reference, path: str) -> str:
    """The file's git blob hash at the reference commit, or "missing"."""
    r = subprocess.run(
        ["git", "-c", f"safe.directory={ref.git_dir}", "--git-dir", ref.git_dir,
         "rev-parse", "--verify", "--quiet", f"{ref.commit}:{path}"],
        capture_output=True, text=True, timeout=30, check=False,
    )
    return r.stdout.strip() if r.returncode == 0 else "missing"


def text_hash(value: object) -> str:
    data = value if isinstance(value, str) else json.dumps(value, sort_keys=True)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()[:16]


# ── Kinds and items ──────────────────────────────────────────────────────────


@dataclass
class Kind:
    kind: str
    question: str  # a template: {field} from the item's facts
    skill: str
    schema: dict
    mode: str  # "triage" | "discovery"
    risk: str  # "boundary" | "platform" | "ordinary"
    positive_field: str
    positive_values: list
    refuter_skill: str | None = None
    severity_field: str | None = None
    reproduction_field: str | None = None
    evidence_field: str = "evidence"
    max_turns: int | None = None  # the investigation's turn budget; Investigate's default if unset
    max_usd: float | None = None  # what one investigation may spend; Investigate's default if unset

    @property
    def version(self) -> str:
        """Changes when the descriptor, its skill or its refuter's skill change."""
        parts = [json.dumps(self.__dict__, sort_keys=True)]
        for path in (self.skill, self.refuter_skill):
            if path and os.path.exists(path):
                with open(path, encoding="utf-8") as f:
                    parts.append(f.read())
        return text_hash("\n".join(parts))


def load_kinds(directory: str) -> dict:
    kinds = {}
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(directory, name), encoding="utf-8") as f:
            d = json.load(f)
        if d.get("mode") not in ("triage", "discovery"):
            raise ValueError(f"{name}: mode must be triage or discovery")
        if d.get("risk") not in DEFAULT_MAX_AGE_DAYS:
            raise ValueError(f"{name}: risk must be one of {sorted(DEFAULT_MAX_AGE_DAYS)}")
        pos = d["positive"]
        # A skill path may be relative to the descriptor's folder (a team skill's own files).
        for key in ("skill", "refuter_skill"):
            if d.get(key) and not os.path.isabs(d[key]):
                d[key] = os.path.normpath(os.path.join(directory, d[key]))
        kinds[d["kind"]] = Kind(
            kind=d["kind"], question=d["question"], skill=d["skill"], schema=d["schema"],
            mode=d["mode"], risk=d["risk"], positive_field=pos["field"],
            positive_values=pos["values"], refuter_skill=d.get("refuter_skill"),
            severity_field=d.get("severity_field"), reproduction_field=d.get("reproduction_field"),
            evidence_field=d.get("evidence_field", "evidence"), max_turns=d.get("max_turns"),
            max_usd=d.get("max_usd"),
        )
    return kinds


def load_items(path: str) -> list:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


# ── Fingerprints ─────────────────────────────────────────────────────────────


def dependencies(ref: Reference, kind: Kind, item: dict, cited: list) -> list:
    """Everything a verdict depends on, each with its hash at the commit."""
    deps = [
        {"dep": "pipeline", "hash": PIPELINE_VERSION},
        {"dep": "kind", "hash": kind.version},
        {"dep": "facts", "hash": text_hash(item.get("facts", {}))},
    ]
    files = sorted(set(item.get("deps", {}).get("files", [])) | set(cited))
    deps += [{"dep": f"file:{p}", "hash": file_hash(ref, p)} for p in files]
    return deps


def changed(ref: Reference, kind: Kind, item: dict, stored: dict) -> str | None:
    """The first recorded dependency whose hash differs now, or None."""
    for d in stored.get("deps", []):
        name = d["dep"]
        if name == "pipeline":
            now = PIPELINE_VERSION
        elif name == "kind":
            now = kind.version
        elif name == "facts":
            now = text_hash(item.get("facts", {}))
        elif name.startswith("file:"):
            now = file_hash(ref, name[5:])
        else:
            continue
        if now != d["hash"]:
            return name
    return None


def due(ref, kind, item, stored, max_age_days, now) -> str | None:
    """Why the item must be reviewed now, or None to skip it."""
    if not stored:
        return "new"
    what = changed(ref, kind, item, stored)
    if what:
        return f"changed: {what}"
    if now - stored.get("reviewedAt", 0) > max_age_days[kind.risk] * 86400:
        return "rotation"
    return None


# ── Acceptance ───────────────────────────────────────────────────────────────


def _norm(s: str) -> str:
    return " ".join(s.split())


def _occurrences(lines: list, quote: str) -> list:
    """The 1-based lines where `quote` starts (spanning as many lines as it has)."""
    q, span = _norm(quote), quote.count("\n") + 1
    hits = [i for i in range(len(lines)) if q in _norm(" ".join(lines[i:i + span]))]
    # A window that holds the quote also matches from the line before it: keep each run's last.
    return [i + 1 for n, i in enumerate(hits) if n + 1 == len(hits) or hits[n + 1] != i + 1]


def accept(ref: Reference, kind: Kind, answer: dict) -> list:
    """Why the answer is not acceptable; empty when it is."""
    problems = []
    evidence = answer.get(kind.evidence_field) or []
    if not evidence:
        problems.append("no evidence")
    for e in evidence:
        path, line, quote = e.get("file"), e.get("line"), e.get("quote")
        if not isinstance(path, str) or ".." in path.split("/") or path.startswith("/"):
            problems.append(f"bad path {path!r}")
            continue
        full = os.path.join(ref.tree, path)
        if not os.path.isfile(full):
            problems.append(f"{path} does not exist at {ref.commit[:10]}")
            continue
        with open(full, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
        if not isinstance(line, int) or not 1 <= line <= len(lines):
            problems.append(f"{path}:{line} is not a line of the file ({len(lines)} lines)")
            continue
        if quote:
            lo, hi = max(0, line - 1 - QUOTE_WINDOW), min(len(lines), line + QUOTE_WINDOW)
            if _norm(quote) not in _norm(" ".join(lines[lo:hi])):
                found = _occurrences(lines, quote)
                if len(found) == 1:
                    # A real quote cited at a drifted line: correct the line, keep the evidence.
                    e["relocated_from"], e["line"] = line, found[0]
                elif found:
                    problems.append(f"quote not found near {path}:{line} (it occurs {len(found)} times elsewhere)")
                else:
                    problems.append(f"quote not found in {path}")
    if kind.severity_field and kind.reproduction_field:
        sev = answer.get(kind.severity_field, "low")
        if sev in SEVERITY_ORDER and SEVERITY_ORDER.index(sev) > SEVERITY_ORDER.index("low"):
            if not str(answer.get(kind.reproduction_field) or "").strip():
                problems.append(f"severity {sev} without a reproduction")
    return problems


# ── The pipeline ─────────────────────────────────────────────────────────────

REFUTER_SCHEMA = {
    "type": "object",
    "required": ["refuted", "reason"],
    "properties": {"refuted": {"type": "boolean"}, "reason": {"type": "string"}},
}


@dataclass
class Budget:
    max_calls: int
    used: int = 0
    # time.monotonic() after which no investigation starts, so a run ends (and is recorded)
    # before the job's wall-clock limit kills it.
    deadline: float | None = None
    # Money: the day's spend against its budget (work_queue.DaySpend), and this run's.
    day: "work_queue.DaySpend | None" = None
    spent_usd: float = 0.0
    stopped: str = ""  # which limit refused the last take: calls | time | daily budget
    # What all of one item's investigations together may cost; None = no item limit.
    item_usd: float | None = None

    def take(self, n: int = 1) -> bool:
        if self.used + n > self.max_calls:
            self.stopped = "calls"
        elif self.deadline is not None and time.monotonic() >= self.deadline:
            self.stopped = "time"
        elif self.day is not None and self.day.exhausted(time.time()):
            self.stopped = "daily budget"
        else:
            self.used += n
            return True
        return False

    def charge(self, usd: float) -> None:
        self.spent_usd += usd
        if self.day is not None:
            self.day.add(usd, time.time())


@dataclass
class Outcome:
    item_id: str
    status: str  # skipped | deferred | held | negative | finding | rejected | refuted | unconfirmed | incomplete | set-aside | over-budget | failed
    reason: str = ""
    answer: dict | None = None
    problems: list = field(default_factory=list)
    cost_usd: float = 0.0


def is_positive(kind: Kind, answer: dict) -> bool:
    return answer.get(kind.positive_field) in kind.positive_values


class Incomplete(Exception):
    """An investigation that ran out of time, turns or money: its answer is not a verdict."""


class OverBudget(Exception):
    """The item's budget cannot cover its next investigation: no verdict, until something changes."""


# Investigate's own default cap; an item budget never gives one investigation more than this.
INVESTIGATE_DEFAULT_USD = 0.5
# Less than this left for an item is not enough to start an investigation worth having.
MIN_INVESTIGATION_USD = 0.05


COST_IN_ERROR = re.compile(r"\(cost_usd ([0-9.eE+-]+)\)\s*$")


def cost_of_error(e: Exception) -> float:
    """Investigate puts the cost of a failed investigation at the end of its error."""
    m = COST_IN_ERROR.search(str(e))
    try:
        return float(m.group(1)) if m else 0.0
    except ValueError:
        return 0.0


def review_item(item, kind, ref, investigate, budget) -> tuple:
    """(Outcome, the answer to store or None); the outcome carries what its investigations cost."""
    before = budget.spent_usd
    try:
        outcome, answer = _review_item(item, kind, ref, investigate, budget)
    except Incomplete as e:  # never stored: the next run asks again
        outcome, answer = Outcome(item["id"], "incomplete", str(e)[:500]), None
    except OverBudget as e:  # stored as a marker: not asked again until something changes
        outcome, answer = Outcome(item["id"], "over-budget", str(e)[:500]), None
    outcome.cost_usd = round(budget.spent_usd - before, 6)
    return outcome, answer


def _charged(investigate, budget):
    """Investigate, with every call's cost charged to the budget, whether it answered or failed."""
    def call(**kw):
        try:
            out = investigate(**kw)
        except Exception as e:
            budget.charge(cost_of_error(e))
            raise
        budget.charge(float(out.get("cost_usd", 0) or 0))
        return out
    return call


def _review_item(item, kind, ref, investigate, budget) -> tuple:
    iid = item["id"]
    question = kind.question.format(**item.get("facts", {}))
    investigate = _charged(investigate, budget)
    start = budget.spent_usd

    def cap(stage):
        """This investigation's money cap: the kind's, within what is left of the item's budget."""
        own = kind.max_usd
        if budget.item_usd is None:
            return own
        left = budget.item_usd - (budget.spent_usd - start)
        if left < MIN_INVESTIGATION_USD:
            raise OverBudget(f"the item's ${budget.item_usd} budget was spent before the {stage} "
                             f"(${round(budget.spent_usd - start, 4)} so far)")
        return round(min(own or INVESTIGATE_DEFAULT_USD, left), 4)

    def ask(skill, q, schema, briefing, stage="investigation"):
        extra = {"max_turns": kind.max_turns} if kind.max_turns else {}
        usd = cap(stage)
        if usd:
            extra["max_usd"] = usd
        out = investigate(question=q, answer_schema=schema, skill_file=skill,
                          briefing=briefing, reference=ref.name, **extra)
        if out.get("incomplete"):
            inc = out["incomplete"]
            raise Incomplete(f"{stage} ran out of {inc.get('reason')}: {inc.get('note', '')}")
        return out["answer"]

    if not budget.take():
        return Outcome(iid, "deferred", f"budget: {budget.stopped}"), None
    try:
        first = ask(kind.skill, question, kind.schema, item.get("briefing", ""))
    except (Incomplete, OverBudget):
        raise
    except Exception as e:  # an investigation that fails is recorded, never fatal to the run
        return Outcome(iid, "failed", str(e)[:300]), None
    if not is_positive(kind, first):
        return Outcome(iid, "negative", answer=first), first

    if kind.mode == "triage":
        if not budget.take(2):
            return Outcome(iid, "deferred", f"budget: {budget.stopped} (confirmation)",
                           answer=first), None
        votes = [first]
        for _ in range(2):
            try:
                votes.append(ask(kind.skill, question, kind.schema, item.get("briefing", ""),
                                 stage="confirmation"))
            except (Incomplete, OverBudget):
                raise
            except Exception as e:
                votes.append({"error": str(e)[:200]})
        if sum(is_positive(kind, v) for v in votes) < 2:
            return Outcome(iid, "unconfirmed", "1 of 3 runs", answer=first), first

    problems = accept(ref, kind, first)
    if problems:
        return Outcome(iid, "rejected", "acceptance", answer=first, problems=problems), first

    if kind.refuter_skill:
        if not budget.take():
            return Outcome(iid, "deferred", f"budget: {budget.stopped} (refuter)",
                           answer=first), None
        brief = (f"{item.get('briefing', '')}\n\n## The finding to test\n\n"
                 f"```json\n{json.dumps(first, indent=2)}\n```")
        try:
            verdict = ask(kind.refuter_skill,
                          f"Try to disprove this finding about {iid}. Is it wrong?",
                          REFUTER_SCHEMA, brief, stage="refuter")
        except (Incomplete, OverBudget):
            raise
        except Exception as e:
            return Outcome(iid, "failed", f"refuter: {str(e)[:300]}", answer=first), None
        if verdict.get("refuted"):
            return Outcome(iid, "refuted", verdict.get("reason", "")[:500], answer=first), first

    return Outcome(iid, "finding", answer=first), first


def cited_files(kind: Kind, answer: dict | None) -> list:
    if not answer:
        return []
    return [e["file"] for e in answer.get(kind.evidence_field) or []
            if isinstance(e, dict) and isinstance(e.get("file"), str)]


# Outcomes that leave an item on the to-do list for the next run.
LEFT = ("deferred", "incomplete", "failed", "held")
# Stored markers (no verdict) that keep an item out of the runs until something it depends on
# changes or the agent pins it.
SET_ASIDE = ("over-budget", "set-aside")
# An item that comes back incomplete this many times in a row is set aside: asking again would
# spend the same money for the same answer, and wake the agent every run.
MAX_INCOMPLETE = 2


def _why_again(stored, pinned: bool) -> str | None:
    """Why an unchanged item with a marker is due anyway: a retry after one incomplete answer, or
    a pin after it was set aside."""
    status = (stored or {}).get("status")
    if status == "incomplete" and stored.get("attempts", 1) < MAX_INCOMPLETE:
        return "retry after incomplete"
    if status in SET_ASIDE and pinned:
        return f"pinned after {status}"
    return None


def _marker(ref, kind, item, now, status, why, attempts=None) -> dict:
    m = {"kind": kind.kind, "status": status, "answer": None, "commit": ref.commit,
         "reviewedAt": now, "why": why, "deps": dependencies(ref, kind, item, [])}
    if attempts is not None:
        m["attempts"] = attempts
    return m


def run(items, kinds, ref, store, investigate, budget, max_age_days, now, save=None,
        overrides=None, seen=None) -> list:
    """Reviews the due items in the queue's order (work_queue.order); `save(store)` after each
    new verdict, so a run cut short keeps them."""
    outcomes, due_items = [], []
    for item in items:
        kind = kinds.get(item.get("kind"))
        if kind is None:
            outcomes.append(Outcome(item.get("id", "?"), "failed", f"unknown kind {item.get('kind')!r}"))
            continue
        stored = store.get(item["id"])
        why = due(ref, kind, item, stored, max_age_days, now)
        if why is None:
            pinned = (overrides or {}).get(item["id"], {}).get("pin") == "top"
            why = _why_again(stored, pinned)
        if why is None:
            outcomes.append(Outcome(item["id"], "skipped", "unchanged"))
        else:
            due_items.append((item, why))
    overrides = overrides or {}
    work, held = work_queue.order(due_items, overrides, seen or {}, now)
    for item, why in held:
        outcomes.append(Outcome(item["id"], "held", overrides[item["id"]]["reason"][:300]))
    for item, why in work:
        kind = kinds[item["kind"]]
        outcome, answer = review_item(item, kind, ref, investigate, budget)
        outcome.reason = outcome.reason or why
        if outcome.status == "incomplete":
            prior = store.get(item["id"]) or {}
            attempts = prior.get("attempts", 1) + 1 if why == "retry after incomplete" else 1
            if attempts >= MAX_INCOMPLETE:
                outcome.status = "set-aside"
                outcome.reason = f"incomplete {attempts} times in a row; {outcome.reason}"[:500]
            store[item["id"]] = _marker(ref, kind, item, now, outcome.status, outcome.reason,
                                        attempts)
            if save is not None:
                save(store)
        elif outcome.status == "over-budget":
            store[item["id"]] = _marker(ref, kind, item, now, "over-budget", outcome.reason)
            if save is not None:
                save(store)
        elif answer is not None:
            store[item["id"]] = {
                "kind": kind.kind, "status": outcome.status, "answer": answer,
                "commit": ref.commit, "reviewedAt": now, "why": why,
                "deps": dependencies(ref, kind, item, cited_files(kind, answer)),
            }
            if save is not None:
                save(store)
        outcomes.append(outcome)
    return outcomes


# ── Command line ─────────────────────────────────────────────────────────────


def _write_json(path: str, value) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=1)
    os.replace(tmp, path)


def main(argv: list, investigate=None, reference_root: str = REFERENCE_ROOT) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--items", required=True)
    ap.add_argument("--kinds", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--reference", required=True)
    ap.add_argument("--max-calls", type=int, default=40)
    ap.add_argument("--max-minutes", type=float, default=None,
                    help="start no investigation after this many minutes; the rest is deferred")
    ap.add_argument("--max-usd-per-day", type=float, default=None,
                    help="start no investigation once today's spend (UTC) reaches this; the rest is deferred")
    ap.add_argument("--max-usd-per-item", type=float, default=None,
                    help="what all of one item's investigations may cost; past it the item is over-budget")
    ap.add_argument("--max-age", action="append", default=[], help="risk=days")
    ap.add_argument("--reference-root", default=reference_root, help=argparse.SUPPRESS)
    a = ap.parse_args(argv)

    max_age = dict(DEFAULT_MAX_AGE_DAYS)
    for spec in a.max_age:
        risk, days = spec.split("=", 1)
        if risk not in max_age:
            raise SystemExit(f"--max-age: unknown risk class {risk!r}")
        max_age[risk] = float(days)
    if investigate is None:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                                        "run-background", "scripts"))
        import magi_tool  # noqa: E402 — only when run as a real job
        investigate = magi_tool.investigate

    os.makedirs(a.state, exist_ok=True)
    store_path = os.path.join(a.state, "verdicts.json")
    store = {}
    if os.path.exists(store_path):
        with open(store_path, encoding="utf-8") as f:
            store = json.load(f)
    ref = load_reference(a.reference, a.reference_root)
    now = time.time()
    deadline = None if a.max_minutes is None else time.monotonic() + 60 * a.max_minutes
    day = work_queue.DaySpend.load(a.state, a.max_usd_per_day)
    budget = Budget(a.max_calls, deadline=deadline, day=day, item_usd=a.max_usd_per_item)
    items = load_items(a.items)
    seen = work_queue.first_seen(a.state, items, now)
    overrides, override_notes = work_queue.load_overrides(a.state)
    outcomes = run(items, load_kinds(a.kinds), ref, store, investigate,
                   budget, max_age, now, save=lambda s: _write_json(store_path, s),
                   overrides=overrides, seen=seen)
    _write_json(store_path, store)
    by_id = {i["id"]: i for i in items}
    left = [(by_id[o.item_id], o.status) for o in outcomes
            if o.status in LEFT and o.item_id in by_id]

    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now))
    out_dir = os.path.join(a.state, "runs", stamp)
    os.makedirs(out_dir, exist_ok=True)
    findings = [o.__dict__ for o in outcomes if o.status == "finding"]
    _write_json(os.path.join(out_dir, "findings.json"), findings)
    counts = {}
    for o in outcomes:
        counts[o.status] = counts.get(o.status, 0) + 1
    summary = {"commit": ref.commit, "items": len(outcomes), "calls": budget.used,
               "maxCalls": budget.max_calls, "counts": counts, "findings": len(findings),
               "costUsd": round(budget.spent_usd, 4),
               "backlog": work_queue.backlog(left, seen, now, day, over_budget=sum(
                   1 for i in items if store.get(i["id"], {}).get("status") == "over-budget"),
                   set_aside=sum(
                   1 for i in items if store.get(i["id"], {}).get("status") == "set-aside")),
               **({"overrideNotes": override_notes} if override_notes else {})}
    _write_json(os.path.join(out_dir, "summary.json"), summary)
    with open(os.path.join(a.state, "ledger.jsonl"), "a", encoding="utf-8") as f:
        for o in outcomes:
            f.write(json.dumps({"run": stamp, "commit": ref.commit, "item": o.item_id,
                                "status": o.status, "reason": o.reason,
                                "problems": o.problems, "costUsd": o.cost_usd}) + "\n")
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
