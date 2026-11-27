"""review.py (security assurance plan, step 6b): offline, against a real git mirror in a
temporary folder laid out like a platform task's reference copy. Investigate is scripted."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "packages" / "skills" / "review-pipeline" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import review  # noqa: E402

SCHEMA = {
    "type": "object",
    "required": ["verdict", "evidence"],
    "properties": {"verdict": {"enum": ["real", "false-positive"]}, "evidence": {"type": "array"}},
}
SOURCE = "\n".join(f"line {i}" for i in range(1, 30)) + "\nconst p = req.query.path;\n"


def git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


class World:
    """A reference copy named 'repo' with one source file, the kinds, and a scripted Investigate."""

    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.work = tmp / "work"
        self.refroot = tmp / "reference"
        self.ref = self.refroot / "repo"
        self.work.mkdir()
        git("init", "-q", "-b", "main", cwd=self.work)
        (self.work / "src").mkdir()
        self.write("src/a.ts", SOURCE)
        self.write("src/b.ts", "other\n")
        self.ref.mkdir(parents=True)
        self.publish()
        self.kinds = tmp / "kinds"
        self.kinds.mkdir()
        (tmp / "SKILL.md").write_text("Triage the alert.")
        (tmp / "REFUTE.md").write_text("Disprove it.")
        self.kind("alert", mode="triage")
        self.answers = []
        self.calls = []

    def write(self, path, text):
        (self.work / path).write_text(text)

    def publish(self):
        """Commit the work tree and lay it out as git-mirror does."""
        git("add", "-A", cwd=self.work)
        git("commit", "-q", "--allow-empty", "-m", "c", cwd=self.work)
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.work, check=True,
                                capture_output=True, text=True).stdout.strip()
        shutil.rmtree(self.ref / "mirror.git", ignore_errors=True)
        git("clone", "-q", "--bare", str(self.work), str(self.ref / "mirror.git"), cwd=self.tmp)
        snap = self.ref / "snapshots" / commit
        if not snap.exists():
            shutil.copytree(self.work, snap, ignore=shutil.ignore_patterns(".git"))
        (self.ref / "status.json").write_text(json.dumps({"commit": commit}))
        self.commit = commit

    def kind(self, name, mode, **over):
        d = {"kind": name, "question": "Is alert {number} real?", "skill": str(self.tmp / "SKILL.md"),
             "schema": SCHEMA, "mode": mode, "risk": "boundary",
             "positive": {"field": "verdict", "values": ["real"]},
             "refuter_skill": str(self.tmp / "REFUTE.md"), **over}
        (self.kinds / f"{name}.json").write_text(json.dumps(d))

    def investigate(self, **kw):
        self.calls.append(kw)
        nxt = self.answers.pop(0) if self.answers else {"verdict": "false-positive", "evidence": []}
        if isinstance(nxt, Exception):
            raise nxt
        out = {"answer": nxt, "reference": {"name": "repo", "commit": self.commit}, "turns": 1}
        if isinstance(nxt, dict) and "incomplete" in nxt:
            out["answer"] = {k: v for k, v in nxt.items() if k != "incomplete"}
            out["incomplete"] = nxt["incomplete"]
        return out

    def run(self, items, now=1_000_000.0, max_calls=40, store=None):
        store = {} if store is None else store
        ref = review.load_reference("repo", str(self.refroot))
        out = review.run(items, review.load_kinds(str(self.kinds)), ref, store, self.investigate,
                         review.Budget(max_calls), review.DEFAULT_MAX_AGE_DAYS, now)
        return out, store


REAL = {"verdict": "real", "evidence": [{"file": "src/a.ts", "line": 30, "quote": "req.query.path"}]}
FP = {"verdict": "false-positive", "evidence": [{"file": "src/a.ts", "line": 30, "quote": "req.query.path"}]}
ITEM = {"id": "cs-1", "kind": "alert", "facts": {"number": 1}, "briefing": "semgrep at src/a.ts:30"}


@pytest.fixture
def w(tmp_path):
    return World(tmp_path)


def test_an_unchanged_item_is_skipped_without_a_call(w):
    w.answers = [FP]
    out, store = w.run([ITEM])
    assert out[0].status == "negative" and len(w.calls) == 1
    out, _ = w.run([ITEM], store=store)
    assert out[0].status == "skipped" and len(w.calls) == 1


def test_a_change_to_a_cited_file_brings_it_back(w):
    w.answers = [FP]
    _, store = w.run([ITEM])
    w.write("src/b.ts", "changed\n")  # not cited: still skipped
    w.publish()
    out, _ = w.run([ITEM], store=store)
    assert out[0].status == "skipped"
    w.write("src/a.ts", SOURCE + "// edit\n")
    w.publish()
    w.answers = [FP]
    out, _ = w.run([ITEM], store=store)
    assert out[0].status == "negative" and out[0].reason == "changed: file:src/a.ts"


def test_a_changed_skill_brings_it_back(w):
    w.answers = [FP]
    _, store = w.run([ITEM])
    (w.tmp / "SKILL.md").write_text("Triage the alert, better.")
    w.answers = [FP]
    out, _ = w.run([ITEM], store=store)
    assert out[0].reason == "changed: kind"


def test_rotation_after_the_risk_class_maximum_age(w):
    w.answers = [FP]
    _, store = w.run([ITEM], now=0)
    out, _ = w.run([ITEM], now=13 * 86400, store=store)
    assert out[0].status == "skipped"
    w.answers = [FP]
    out, _ = w.run([ITEM], now=15 * 86400, store=store)
    assert out[0].reason == "rotation"


def test_a_triage_finding_needs_two_of_three_then_survives_the_refuter(w):
    w.answers = [REAL, FP, REAL, {"refuted": False, "reason": "holds"}]
    out, _ = w.run([ITEM])
    assert out[0].status == "finding" and len(w.calls) == 4
    assert w.calls[3]["skill_file"].endswith("REFUTE.md")


def test_one_positive_of_three_is_unconfirmed(w):
    w.answers = [REAL, FP, FP]
    out, _ = w.run([ITEM])
    assert out[0].status == "unconfirmed" and len(w.calls) == 3


def test_a_refuted_finding_is_dropped(w):
    w.answers = [REAL, REAL, REAL, {"refuted": True, "reason": "the path is validated upstream"}]
    out, _ = w.run([ITEM])
    assert out[0].status == "refuted" and "validated upstream" in out[0].reason


def test_discovery_keeps_a_single_candidate_for_the_refuter(w):
    w.kind("cell", mode="discovery")
    w.answers = [REAL, {"refuted": False, "reason": "holds"}]
    out, _ = w.run([{**ITEM, "id": "cell-1", "kind": "cell"}])
    assert out[0].status == "finding" and len(w.calls) == 2


@pytest.mark.parametrize("evidence, problem", [
    ([], "no evidence"),
    ([{"file": "src/zz.ts", "line": 1, "quote": "x"}], "does not exist"),
    ([{"file": "src/a.ts", "line": 999, "quote": "x"}], "is not a line"),
    ([{"file": "src/a.ts", "line": 30, "quote": "req.body.path"}], "quote not found in src/a.ts"),
    ([{"file": "src/a.ts", "line": 30, "quote": "line 1"}], "occurs"),
    ([{"file": "../etc/passwd", "line": 1, "quote": "root"}], "bad path"),
])
def test_acceptance_rejects_invented_evidence(w, evidence, problem):
    w.kind("cell", mode="discovery")
    w.answers = [{"verdict": "real", "evidence": evidence}]
    out, _ = w.run([{**ITEM, "id": "cell-1", "kind": "cell"}])
    assert out[0].status == "rejected"
    assert any(problem in p for p in out[0].problems), out[0].problems


def test_above_low_severity_needs_a_reproduction(w):
    w.kind("cell", mode="discovery", severity_field="severity", reproduction_field="reproduction")
    w.answers = [{**REAL, "severity": "high", "reproduction": ""}]
    out, _ = w.run([{**ITEM, "id": "cell-1", "kind": "cell"}])
    assert out[0].status == "rejected" and "without a reproduction" in out[0].problems[0]


def test_the_budget_defers_what_it_cannot_reach(w):
    items = [{**ITEM, "id": f"cs-{i}"} for i in range(3)]
    out, store = w.run(items, max_calls=2)
    assert [o.status for o in out] == ["negative", "negative", "deferred"]
    assert "cs-2" not in store


def test_past_the_deadline_nothing_starts_and_the_rest_is_deferred(w):
    ref = review.load_reference("repo", str(w.refroot))
    budget = review.Budget(40, deadline=review.time.monotonic() - 1)
    out = review.run([ITEM], review.load_kinds(str(w.kinds)), ref, {}, w.investigate, budget,
                     review.DEFAULT_MAX_AGE_DAYS, 1_000_000.0)
    assert [o.status for o in out] == ["deferred"] and w.calls == []


def test_each_verdict_is_saved_as_it_is_reached(w):
    items = [{**ITEM, "id": f"cs-{i}"} for i in range(2)]
    saved = []
    ref = review.load_reference("repo", str(w.refroot))

    def investigate(**kw):
        if len(w.calls) == 1:
            assert "cs-0" in saved[-1], "the first verdict is saved before the second call"
        return w.investigate(**kw)

    review.run(items, review.load_kinds(str(w.kinds)), ref, {}, investigate, review.Budget(40),
               review.DEFAULT_MAX_AGE_DAYS, 1_000_000.0, save=lambda s: saved.append(dict(s)))
    assert [sorted(s) for s in saved] == [["cs-0"], ["cs-0", "cs-1"]]


def test_an_incomplete_investigation_is_recorded_with_its_reason_and_not_stored(w):
    w.answers = [{**FP, "incomplete": {"reason": "time", "note": "could not read b.ts"}}]
    out, store = w.run([ITEM])
    assert out[0].status == "incomplete" and "cs-1" not in store
    assert "investigation ran out of time: could not read b.ts" in out[0].reason


def test_an_incomplete_confirmation_makes_the_item_incomplete(w):
    w.answers = [REAL, {**REAL, "incomplete": {"reason": "turns", "note": "unfinished"}}]
    out, store = w.run([ITEM])
    assert out[0].status == "incomplete" and "confirmation" in out[0].reason
    assert "cs-1" not in store


def test_a_failed_investigation_is_recorded_and_not_stored(w):
    w.answers = [RuntimeError("the answer did not match the schema")]
    out, store = w.run([ITEM])
    assert out[0].status == "failed" and "cs-1" not in store


def test_main_writes_the_store_the_findings_the_summary_and_the_ledger(w, capsys):
    items = w.tmp / "items.jsonl"
    items.write_text(json.dumps(ITEM) + "\n")
    state = w.tmp / "state"
    w.answers = [REAL, REAL, FP, {"refuted": False, "reason": "holds"}]
    rc = review.main(["--items", str(items), "--kinds", str(w.kinds), "--state", str(state),
                      "--reference", "repo"], investigate=w.investigate, reference_root=str(w.refroot))
    assert rc == 0
    summary = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert summary["findings"] == 1 and summary["calls"] == 4 and summary["commit"] == w.commit
    assert "cs-1" in json.loads((state / "verdicts.json").read_text())
    ledger = (state / "ledger.jsonl").read_text().splitlines()
    assert json.loads(ledger[0])["status"] == "finding"


def test_skill_paths_may_be_relative_to_the_descriptor(w):
    w.kind("rel", mode="triage", skill="../SKILL.md", refuter_skill="../REFUTE.md")
    k = review.load_kinds(str(w.kinds))["rel"]
    assert k.skill == str(w.tmp / "SKILL.md") and k.refuter_skill == str(w.tmp / "REFUTE.md")


def test_a_quote_cited_at_a_drifted_line_is_relocated(w):
    w.kind("cell", mode="discovery")
    w.answers = [{"verdict": "real", "evidence": [{"file": "src/a.ts", "line": 3, "quote": "req.query.path"}]},
                 {"refuted": False, "reason": "holds"}]
    out, store = w.run([{**ITEM, "id": "cell-1", "kind": "cell"}])
    assert out[0].status == "finding", out[0].problems
    ev = store["cell-1"]["answer"]["evidence"][0]
    assert ev["line"] == 30 and ev["relocated_from"] == 3


def test_a_kind_sets_the_investigation_turn_budget(w):
    w.kind("alert", mode="triage", max_turns=30)
    w.answers = [FP]
    w.run([ITEM])
    assert w.calls[0]["max_turns"] == 30
