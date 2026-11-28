"""MAGI DEV's daily brief and the triage status it reads: offline, against files in a temporary
folder."""
import datetime as dt
import json
import os
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

REPO = Path(__file__).resolve().parents[2]
TEAM = REPO / "config" / "teams" / "magi-dev" / "skills"
sys.path.insert(0, str(TEAM / "daily-brief" / "scripts"))
sys.path.insert(0, str(TEAM / "alert-triage" / "scripts"))
import daily_brief  # noqa: E402
import publish_status  # noqa: E402

NY = ZoneInfo("America/New_York")
REGISTER = """# Register

### MD-001 · LOW · imported — AnalyzeMemories query has no length cap
- **Where:** a.ts:29
- **History:** Sprint 28 · imported 2026-11-10 · 2026-11-27 reviewed

### MD-002 · MEDIUM · reported — Copilot tools lack a gate
- **Found:** 2026-11-20, change review
- **History:** 2026-11-20 new

### MD-003 · HIGH · fix proposed — Token kept after exit
- **Found:** 2026-11-28, alert triage cs-41 run 20261128T010000Z
"""


def utc(*a):
    return dt.datetime(*a, tzinfo=dt.timezone.utc)


@pytest.fixture
def mission(tmp_path):
    shared = tmp_path / "shared"
    for area in ("security", "code-review", "docs", "gate"):
        (shared / "reports" / area).mkdir(parents=True)
    (shared / "reports" / "security" / "register.md").write_text(REGISTER)
    (shared / "reports" / "code-review" / "2026-11-28-change-review.md").write_text(
        "# Change review\n**Findings:** CR-031 (issue, blocking) lock never released; "
        "CR-032 (suggestion) name the helper\n")
    (shared / "reports" / "docs" / "2026-11-28-commits.md").write_text(
        "# Documentation check\n**Findings:** DC-012 (wrong) USER_GUIDE says the port is 4002\n")
    (shared / "reports" / "gate" / "state.json").write_text(json.dumps({"reports": {
        "code-review/2026-11-28-change-review.md": {"status": "accepted", "not_found": 0},
        "docs/2026-11-28-commits.md": {"status": "rejected", "not_found": 2}}}))
    (shared / "reports" / "review-cursor.json").write_text(json.dumps({
        "appsec": {"commit": "803571f", "at": "2026-11-23T12:51:51+00:00"},
        "documenter": {"commit": "24ed0d1", "at": "2026-11-28T00:37:27+00:00"}}))
    ref = tmp_path / "ref.json"
    ref.write_text(json.dumps({"commit": "24ed0d1363b56261f9aa7097ba5a38e2e1ae54ee"}))
    return shared, tmp_path / "work", ref


def run(mission, now, *extra):
    shared, work, ref = mission
    sent = []
    rc = daily_brief.main([str(shared), str(work), "--reference-status", str(ref), *extra],
                          now_utc=now, post=lambda to, s, b: sent.append((to, s, b)))
    assert rc == 0
    return sent


def test_the_brief_waits_for_six_pm_in_new_york_and_sends_once_a_day(mission):
    # 22:00 UTC is 17:00 in New York in winter: too early. 23:00 is 18:00: sent.
    assert run(mission, utc(2026, 11, 28, 22)) == []
    assert len(run(mission, utc(2026, 11, 28, 23))) == 1
    assert run(mission, utc(2026, 11, 28, 23, 30)) == []
    # In summer 22:00 UTC is 18:00 in New York; the 23:00 run then finds it sent.
    assert len(run(mission, utc(2027, 6, 1, 22))) == 1
    assert run(mission, utc(2027, 6, 1, 23)) == []


def test_the_brief_lists_the_major_issues_and_the_backlog_by_priority(mission):
    (to, subject, body), = run(mission, utc(2026, 11, 28, 23))
    assert to == "user"
    assert "MD-003 · HIGH · fix proposed — Token kept after exit" in body  # found in the last day
    assert "MD-002" not in body.split("## Verified resolved")[0]  # older: not new
    assert "CR-031 (blocking, issue) lock never released" in body
    assert "CR-032" not in body and "1 in code-review reports" in body
    assert "DC-012 (wrong)" in body and "rejected by the citation gate" in body
    assert "HIGH 1 (oldest 23 h), MEDIUM 1 (oldest 9 days), LOW 1 (oldest 19 days)" in body
    assert "appsec at 803571f, last moved 5 days ago; documenter up to date" in body
    assert subject.endswith("3 major issue(s), 0 verified resolved")


def test_the_next_brief_reports_what_changed_since_the_last_one(mission):
    shared, _, _ = mission
    run(mission, utc(2026, 11, 28, 23))
    reg = shared / "reports" / "security" / "register.md"
    reg.write_text(reg.read_text().replace("MD-003 · HIGH · fix proposed", "MD-003 · HIGH · fixed, verified")
                   .replace("MD-001 · LOW · imported", "MD-001 · LOW · accepted risk")
                   + "\n### MD-004 · CRITICAL · new — Path escapes the workdir\n- **Found:** 2026-11-10\n")
    (_, subject, body), = run(mission, utc(2026, 11, 29, 23))
    major, rest = body.split("## Verified resolved")
    assert "MD-004 · CRITICAL" in major  # new to the register, whatever its date
    assert "CR-031" not in major  # that report was in the last brief
    assert "- MD-003 · HIGH — Token kept after exit (fixed, verified)" in rest
    assert "Also closed: MD-001 (accepted risk)" in rest
    assert "CRITICAL 1" in rest and "HIGH" not in rest.split("**Open security findings**")[1].split("\n")[0]
    assert subject.endswith("1 major issue(s), 1 verified resolved")


def test_the_brief_shows_the_triage_backlog_and_flags_a_stale_status(mission):
    shared, _, _ = mission
    (shared / "status").mkdir()
    (shared / "status" / "alert-triage.json").write_text(json.dumps({
        "writtenAt": "2026-11-28T22:00:00Z",
        "backlog": {"left": 3, "byBand": {"low": 2, "high": 1},
                    "oldestByBand": {"high": "2026-11-28T20:00:00Z", "low": "2026-11-25T23:00:00Z"},
                    "spentTodayUsd": 0.68, "dayBudgetUsd": 2.0, "overBudget": 0, "setAside": 1},
        "awaitingVerification": {"count": 1, "byBand": {"high": {"count": 1, "oldestSince": "2026-11-27T23:00:00Z"}}}}))
    (_, _, body), = run(mission, utc(2026, 11, 28, 23))
    assert "**Leads awaiting appsec's verification:** 1: high 1 (oldest 24 h)." in body
    assert "not yet triaged:** 3: high 1 (oldest 3 h), low 2 (oldest 3 days). Set aside 1" in body
    assert "$0.68 of $2.00" in body and "no triage run has published since" not in body
    (_, _, body), = run(mission, utc(2026, 11, 30, 23))
    assert "no triage run has published since" in body


def test_a_report_without_a_findings_line_says_so():
    assert daily_brief.parse_findings("# r\nno line here") is None
    assert daily_brief.parse_findings("**Findings:** none.") == []
    (f,) = daily_brief.parse_findings("**Findings:** something odd")
    assert f["id"] is None and f["tags"] == set()


def test_the_triage_status_counts_findings_the_register_does_not_name(tmp_path):
    state = tmp_path / "state"
    for stamp, found in (("20261126T010000Z", ["cs-4", "cs-41"]), ("20261127T010000Z", ["cs-4", "dep-2"])):
        os.makedirs(state / "runs" / stamp)
        (state / "runs" / stamp / "findings.json").write_text(json.dumps([{"item_id": i} for i in found]))
        (state / "runs" / stamp / "summary.json").write_text(json.dumps({"commit": "abc", "backlog": {"left": 0}}))
    (state / "runs" / "notes").mkdir()
    items = tmp_path / "items.jsonl"
    items.write_text("".join(json.dumps({"id": i, "band": b}) + "\n" for i, b in (("cs-4", "high"), ("dep-2", "low"))))
    s = publish_status.status(str(state), str(items), "MD-003 from cs-41, run 20261126", 0)
    w = s["awaitingVerification"]
    assert [x["id"] for x in w["items"]] == ["cs-4", "dep-2"]  # cs-41 is in the register; cs-4 is not
    assert w["byBand"] == {"high": {"count": 1, "oldestSince": "2026-11-26T01:00:00Z"},
                           "low": {"count": 1, "oldestSince": "2026-11-27T01:00:00Z"}}
    assert s["run"] == "20261127T010000Z" and s["commit"] == "abc"
    out = tmp_path / "shared" / "status" / "alert-triage.json"
    publish_status.write_atomic(str(out), s)
    assert json.loads(out.read_text())["awaitingVerification"]["count"] == 2
