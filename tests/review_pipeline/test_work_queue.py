"""work_queue.py and its use by review.py (docs/plans/work-queues.md): the order work is taken in,
the owning agent's overrides, the daily money budget, and the backlog line. Offline."""
import json
import sys
import time
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / "packages" / "skills" / "review-pipeline" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import review  # noqa: E402
import work_queue  # noqa: E402
from test_review import FP, ITEM, REAL, World  # noqa: E402

NOW = 1_800_000_000.0  # 2027-01-15


def item(i, priority=0, band="low"):
    return {"id": f"cs-{i}", "kind": "alert", "facts": {"number": i}, "priority": priority, "band": band}


def ids(entries):
    return [e[0]["id"] for e in entries]


def test_order_by_priority_then_age_with_rechecks_last():
    """work-item.ordered: new and changed before re-checks, then priority, then the longest waiting."""
    due = [(item(1, 10), "new"), (item(2, 40), "rotation"), (item(3, 40), "new"),
           (item(4, 10), "changed: src/a.ts")]
    seen = {"cs-1": NOW - 100, "cs-4": NOW - 900}
    work, held = work_queue.order(due, {}, seen, NOW)
    assert ids(work) == ["cs-3", "cs-4", "cs-1", "cs-2"] and held == []


def test_a_pin_goes_first_and_skip_until_holds_until_its_date():
    """work-item.ordered: the agent steers only with a reason: a pin goes first, a hold waits."""
    due = [(item(1, 40), "new"), (item(2, 10), "new"), (item(3, 30), "new")]
    overrides = {"cs-2": {"pin": "top", "reason": "token handling"},
                 "cs-1": {"skip_until": "2099-01-01", "reason": "fix in review"},
                 "cs-3": {"skip_until": "2000-01-01", "reason": "date passed"}}
    work, held = work_queue.order(due, overrides, {}, NOW)
    assert ids(work) == ["cs-2", "cs-3"] and ids(held) == ["cs-1"]


def test_an_override_without_a_reason_or_of_another_shape_is_ignored_and_reported(tmp_path):
    (tmp_path / "priorities.json").write_text(json.dumps({
        "cs-1": {"pin": "top"},
        "cs-2": {"pin": "bottom", "reason": "x"},
        "cs-3": {"pin": "top", "reason": "auth"},
    }))
    good, notes = work_queue.load_overrides(str(tmp_path))
    assert good == {"cs-3": {"pin": "top", "reason": "auth"}}
    assert len(notes) == 2 and notes[0].startswith("cs-1")


def test_first_seen_keeps_the_first_date_and_forgets_what_is_gone(tmp_path):
    work_queue.first_seen(str(tmp_path), [item(1), item(2)], NOW - 500)
    seen = work_queue.first_seen(str(tmp_path), [item(2), item(3)], NOW)
    assert seen == {"cs-2": NOW - 500, "cs-3": NOW}


def test_the_daily_spend_is_kept_per_utc_day_against_the_budget(tmp_path):
    day = work_queue.DaySpend.load(str(tmp_path), 1.0)
    day.add(0.6, NOW)
    assert not day.exhausted(NOW)
    day.add(0.5, NOW)
    assert day.exhausted(NOW) and not day.exhausted(NOW + 86_400)
    again = work_queue.DaySpend.load(str(tmp_path), 1.0)
    assert again.spent(NOW) == 1.1


def test_review_stops_starting_investigations_once_the_day_is_spent(tmp_path):
    """work-item.within-budget: no investigation starts once the day's budget is spent."""
    w = World(tmp_path)
    items = [{**ITEM, "id": f"cs-{i}"} for i in range(4)]

    def investigate(**kw):
        return {**w.investigate(**kw), "cost_usd": 0.3}

    ref = review.load_reference("repo", str(w.refroot))
    day = work_queue.DaySpend.load(str(tmp_path), 0.5)
    budget = review.Budget(40, day=day)
    w.answers = [FP, FP, FP, FP]
    out = review.run(items, review.load_kinds(str(w.kinds)), ref, {}, investigate, budget,
                     review.DEFAULT_MAX_AGE_DAYS, time.time())
    assert [o.status for o in out] == ["negative", "negative", "deferred", "deferred"]
    assert out[2].reason == "budget: daily budget"
    assert [o.cost_usd for o in out] == [0.3, 0.3, 0, 0] and budget.spent_usd == 0.6


def test_the_cost_of_a_failed_investigation_is_charged_too(tmp_path):
    """work-item.within-budget: every investigation's cost is counted, a failed one's too."""
    w = World(tmp_path)
    w.answers = [RuntimeError("Investigate: the model call failed (error): x (cost_usd 0.042)")]
    budget = review.Budget(40)
    ref = review.load_reference("repo", str(w.refroot))
    out = review.run([ITEM], review.load_kinds(str(w.kinds)), ref, {}, w.investigate, budget,
                     review.DEFAULT_MAX_AGE_DAYS, time.time())
    assert out[0].status == "failed" and out[0].cost_usd == 0.042


def test_main_reports_the_backlog_and_each_items_cost(tmp_path, capsys):
    w = World(tmp_path)
    items = tmp_path / "items.jsonl"
    items.write_text("".join(json.dumps({**ITEM, "id": f"cs-{i}", "priority": 10 * i,
                                         "band": "high" if i else "low"}) + "\n" for i in range(3)))
    state = tmp_path / "state"
    def investigate(**kw):
        return {**w.investigate(**kw), "cost_usd": 0.1}

    rc = review.main(["--items", str(items), "--kinds", str(w.kinds), "--state", str(state),
                      "--reference", "repo", "--max-calls", "1"],
                     investigate=investigate, reference_root=str(w.refroot))
    assert rc == 0
    summary = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert summary["costUsd"] == 0.1
    assert summary["backlog"]["left"] == 2 and summary["backlog"]["byBand"] == {"high": 1, "low": 1}
    assert summary["backlog"]["spentTodayUsd"] == 0.1
    ledger = [json.loads(line) for line in (state / "ledger.jsonl").read_text().splitlines()]
    worked = [e for e in ledger if e["status"] != "deferred"]
    assert worked[0]["item"] == "cs-2" and worked[0]["costUsd"] == 0.1


def test_an_items_budget_caps_each_investigation_and_sets_it_aside_when_spent(tmp_path):
    """work-item.within-budget: an item's investigations together stay within its budget; each one
    is capped by what is left; an item that cannot afford its next step is over-budget, kept as a
    marker (not a verdict), skipped until something changes, and asked again when pinned."""
    w = World(tmp_path)
    caps = []

    def investigate(**kw):
        caps.append(kw.get("max_usd"))
        return {**w.investigate(**kw), "cost_usd": 0.3}

    ref = review.load_reference("repo", str(w.refroot))
    kinds = review.load_kinds(str(w.kinds))
    store = {}
    w.answers = [REAL, REAL, REAL]
    out = review.run([ITEM], kinds, ref, store, investigate, review.Budget(40, item_usd=0.5),
                     review.DEFAULT_MAX_AGE_DAYS, time.time())
    assert out[0].status == "over-budget" and "before the confirmation" in out[0].reason
    assert caps == [0.5, 0.2] and out[0].cost_usd == 0.6
    assert store["cs-1"]["status"] == "over-budget" and store["cs-1"]["answer"] is None
    again = review.run([ITEM], kinds, ref, store, investigate, review.Budget(40, item_usd=0.5),
                       review.DEFAULT_MAX_AGE_DAYS, time.time())
    assert again[0].status == "skipped" and len(caps) == 2
    pinned = {"cs-1": {"pin": "top", "reason": "worth more"}}
    w.answers = [FP]
    third = review.run([ITEM], kinds, ref, store, investigate, review.Budget(40, item_usd=0.5),
                       review.DEFAULT_MAX_AGE_DAYS, time.time(), overrides=pinned)
    assert third[0].status == "negative" and third[0].reason == "pinned after over-budget"
