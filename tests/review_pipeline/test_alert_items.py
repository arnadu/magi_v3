"""MAGI DEV's alert-triage producer against its real kind descriptors: offline."""
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SKILL = REPO / "config" / "teams" / "magi-dev" / "skills" / "alert-triage"
sys.path.insert(0, str(SKILL / "scripts"))
sys.path.insert(0, str(REPO / "packages" / "skills" / "review-pipeline" / "scripts"))
import produce_items  # noqa: E402
import review  # noqa: E402

ALERTS = [
    {"source": "code-scanning", "number": 7, "tool": "CodeQL", "rule": "js/path-injection", "severity": "high",
     "path": "packages/x/src/files.ts", "line": 12, "message": "path from a request"},
    {"source": "code-scanning", "number": 2, "tool": "CodeQL", "rule": "js/request-forgery", "severity": "critical",
     "path": "packages/x/src/proxy.ts", "line": 122, "message": "url from a request"},
    {"source": "dependabot", "number": 3, "package": "vite", "ecosystem": "npm", "manifest": "package-lock.json",
     "severity": "medium", "advisory": "GHSA-aaaa", "cve": None, "summary": "s", "vulnerableRange": "< 6.4.6",
     "patched": "6.4.6"},
]


@pytest.fixture
def tree(tmp_path):
    (tmp_path / "docs" / "security").mkdir(parents=True)
    (tmp_path / "scripts" / "security").mkdir(parents=True)
    (tmp_path / "docs" / "security" / "entry-points.json").write_text(json.dumps([
        {"kind": "route", "file": "packages/x/src/files.ts", "line": 10, "name": "GET /files", "tag": "file.read"}]))
    (tmp_path / "scripts" / "security" / "watched-guards.json").write_text(json.dumps({"guards": [
        {"path": "packages/x/src/proxy.ts", "invariant": "sec.safe-egress", "boundary": "TB-1",
         "why": "the only way out", "tests": ["packages/x/tests/proxy.unit.test.ts"]}]}))
    return tmp_path


def test_one_item_per_alert_and_per_guard(tree):
    items = produce_items.produce(ALERTS, str(tree))
    assert [i["id"] for i in items] == ["guard-packages-x-src-proxy.ts", "cs-7", "cs-2", "dep-3"]
    cs7 = next(i for i in items if i["id"] == "cs-7")
    assert "serves operation `file.read`" in cs7["briefing"]
    cs2 = next(i for i in items if i["id"] == "cs-2")
    assert "watched guard" in cs2["briefing"] and "packages/x/tests/proxy.unit.test.ts" in cs2["deps"]["files"]


def test_every_item_fills_its_kind_question(tree):
    kinds = review.load_kinds(str(SKILL / "kinds"))
    for item in produce_items.produce(ALERTS, str(tree)):
        kind = kinds[item["kind"]]
        assert "{" not in kind.question.format(**item["facts"])


def test_the_kinds_name_skills_that_exist():
    for kind in review.load_kinds(str(SKILL / "kinds")).values():
        assert Path(kind.skill).is_file(), kind.skill
        assert Path(kind.refuter_skill).is_file(), kind.refuter_skill
        assert kind.positive_field in kind.schema["properties"]
        assert kind.severity_field in kind.schema["properties"]


def test_main_writes_the_items_from_a_saved_alert_list(tree, tmp_path, capsys):
    alerts = tmp_path / "alerts.json"
    alerts.write_text(json.dumps({"alerts": ALERTS}))
    ref_root = tmp_path / "ref"
    (ref_root / "magi-v3").mkdir(parents=True)
    (ref_root / "magi-v3" / "current").symlink_to(tree)
    (ref_root / "magi-v3" / "status.json").write_text(json.dumps({"commit": "a" * 40}))
    out = tmp_path / "review" / "items.jsonl"
    assert produce_items.main(["--reference", "magi-v3", "--out", str(out), "--alerts", str(alerts)],
                              reference_root=str(ref_root)) == 0
    assert len(out.read_text().splitlines()) == 4
    assert json.loads(capsys.readouterr().out)["byKind"] == {"guard": 1, "code-scanning": 2, "dependabot": 1}


def test_main_refuses_a_reference_copy_not_yet_rebuilt(tree, tmp_path, capsys):
    alerts = tmp_path / "alerts.json"
    alerts.write_text(json.dumps({"alerts": ALERTS}))
    ref_root = tmp_path / "ref"
    (ref_root / "magi-v3").mkdir(parents=True)
    (ref_root / "magi-v3" / "current").symlink_to(tree)  # no status.json yet
    out = tmp_path / "review" / "items.jsonl"
    assert produce_items.main(["--reference", "magi-v3", "--out", str(out), "--alerts", str(alerts),
                               "--wait-seconds", "0"], reference_root=str(ref_root)) == 3
    assert not out.exists()
    assert "not ready" in capsys.readouterr().err


def test_the_wait_ends_when_the_copy_appears(tree, tmp_path):
    ref_root = tmp_path / "ref"
    (ref_root / "magi-v3").mkdir(parents=True)
    (ref_root / "magi-v3" / "current").symlink_to(tree)
    sleeps = []

    def sleep(s):
        sleeps.append(s)
        (ref_root / "magi-v3" / "status.json").write_text("{}")

    assert produce_items.wait_for_reference(str(ref_root), "magi-v3", None, 60, sleep=sleep)
    assert len(sleeps) == 1


def test_priority_is_severity_plus_a_boundary_bonus_and_guards_first(tree):
    (tree / "docs" / "security" / "threat-model.md").write_text(
        "# TM\n\n## Implementing Files by Boundary\n\n### TB-1\n- `packages/x/src/files.ts` — reads files\n"
        "- `packages/y/` — all of it\n\n## Next section\n- `packages/x/src/proxy.ts` — not a boundary list\n")
    items = {i["id"]: i for i in produce_items.produce(ALERTS, str(tree))}
    assert items["guard-packages-x-src-proxy.ts"]["priority"] == produce_items.GUARD
    assert (items["cs-7"]["priority"], items["cs-7"]["band"]) == (30 + produce_items.BOUNDARY_BONUS, "high")
    assert (items["cs-2"]["priority"], items["cs-2"]["band"]) == (40, "critical")
    assert (items["dep-3"]["priority"], items["dep-3"]["band"]) == (20, "medium")


def test_without_a_threat_model_every_alert_is_ranked_by_severity_alone(tree):
    items = {i["id"]: i for i in produce_items.produce(ALERTS, str(tree))}
    assert items["cs-7"]["priority"] == 30


def summary(counts, findings=0):
    return {"commit": "a" * 40, "counts": counts, "findings": findings,
            "backlog": {"left": 3, "byBand": {"high": 1, "low": 2}, "oldestWaitingSince": "2026-11-27T04:00:00Z",
                        "spentTodayUsd": 0.4, "dayBudgetUsd": 2}}


def test_the_agent_is_mailed_for_a_finding_or_trouble_and_once_a_day_otherwise():
    import notify_triage
    s, b, daily = notify_triage.decide("20261127T0500Z", summary({"finding": 1}, findings=1), "2026-11-27", "2026-11-27")
    assert s == "Alert triage: 1 finding(s) to verify" and not daily
    assert "3 left (1 high, 2 low)" in b and "$0.4 spent today of $2" in b
    s, _, _ = notify_triage.decide("x", summary({"negative": 2, "incomplete": 1}), "2026-11-27", "2026-11-27")
    assert s == "Alert triage: 1 incomplete"
    quiet = summary({"negative": 2, "deferred": 3})
    assert notify_triage.decide("x", quiet, "2026-11-27", "2026-11-27") is None
    s, _, daily = notify_triage.decide("x", quiet, "2026-11-28", "2026-11-27")
    assert s == "Alert triage: daily backlog" and daily
