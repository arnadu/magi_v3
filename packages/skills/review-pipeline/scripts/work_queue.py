"""work_queue.py — the to-do list around a review: what to work on first, how much may be spent
today, and how far behind the work is (docs/plans/work-queues.md).

Domain-neutral: an item is known by its `id`, its `priority` (a number from whoever produced the
items; higher first) and its `band` (a label for reports, e.g. a severity). Nothing here knows
what an item is about.

State, in the queue's state folder:
- `seen.json`       when each item was first listed (age, for ordering and the backlog line);
- `spend.json`      money spent per UTC day, against the daily budget;
- `priorities.json` the owning agent's overrides: {"<id>": {"pin": "top", "reason": "…"}} or
                    {"<id>": {"skip_until": "YYYY-MM-DD", "reason": "…"}}. Written by the agent,
                    never by the queue; an entry without a reason, or of another shape, is ignored
                    and reported.
"""
import json
import os
import time
from dataclasses import dataclass, field

DAYS_KEPT = 31


def _read(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write(path: str, value) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=1)
    os.replace(tmp, path)


def utc_day(now: float) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(now))


@dataclass
class DaySpend:
    """Money spent per UTC day; with a budget, `exhausted` once today's spend reaches it."""
    path: str
    budget_usd: float | None = None
    days: dict = field(default_factory=dict)

    @classmethod
    def load(cls, state_dir: str, budget_usd: float | None) -> "DaySpend":
        path = os.path.join(state_dir, "spend.json")
        days = _read(path, {})
        return cls(path, budget_usd, days if isinstance(days, dict) else {})

    def spent(self, now: float) -> float:
        return float(self.days.get(utc_day(now), 0.0))

    def exhausted(self, now: float) -> bool:
        return self.budget_usd is not None and self.spent(now) >= self.budget_usd

    def add(self, usd: float, now: float) -> None:
        if usd <= 0:
            return
        day = utc_day(now)
        self.days[day] = round(self.spent(now) + usd, 6)
        for old in sorted(self.days)[:-DAYS_KEPT]:
            del self.days[old]
        _write(self.path, self.days)


def load_overrides(state_dir: str) -> tuple[dict, list]:
    """The agent's overrides that are well-formed, and a note for each one that is not."""
    raw = _read(os.path.join(state_dir, "priorities.json"), {})
    good, notes = {}, []
    if not isinstance(raw, dict):
        return good, ["priorities.json is not a JSON object: ignored"]
    for item_id, o in raw.items():
        if not isinstance(o, dict) or not str(o.get("reason", "")).strip():
            notes.append(f"{item_id}: ignored, an override needs a reason")
        elif o.get("pin") == "top" and "skip_until" not in o:
            good[item_id] = {"pin": "top", "reason": o["reason"]}
        elif isinstance(o.get("skip_until"), str) and "pin" not in o:
            good[item_id] = {"skip_until": o["skip_until"], "reason": o["reason"]}
        else:
            notes.append(f"{item_id}: ignored, use either pin: top or skip_until: YYYY-MM-DD")
    return good, notes


def first_seen(state_dir: str, items: list, now: float) -> dict:
    """When each listed item was first seen; items no longer listed are forgotten."""
    path = os.path.join(state_dir, "seen.json")
    old = _read(path, {})
    seen = {i["id"]: old.get(i["id"], now) for i in items}
    _write(path, seen)
    return seen


def is_rotation(why: str) -> bool:
    return why == "rotation"


def order(due: list, overrides: dict, seen: dict, now: float) -> tuple[list, list]:
    """(the due items in working order, the items held by a skip_until override).

    `due` is a list of (item, why). Order: pinned first; then new or changed before re-checks of
    an old verdict; then priority, highest first; then the longest waiting.
    """
    today = utc_day(now)
    work, held = [], []
    for item, why in due:
        o = overrides.get(item["id"], {})
        if o.get("skip_until", "") > today:
            held.append((item, why))
        else:
            work.append((item, why))

    def key(entry):
        item, why = entry
        pinned = overrides.get(item["id"], {}).get("pin") == "top"
        return (0 if pinned else 1, 1 if is_rotation(why) else 0,
                -float(item.get("priority", 0)), seen.get(item["id"], now))

    return sorted(work, key=key), held


def backlog(left: list, seen: dict, now: float, spend: DaySpend, over_budget: int = 0) -> dict:
    """How far behind the work is: `left` is the (item, why) still waiting after this run;
    `over_budget` counts items set aside because their own budget ran out (no verdict)."""
    by_band: dict = {}
    for item, _ in left:
        band = str(item.get("band", "unbanded"))
        by_band[band] = by_band.get(band, 0) + 1
    oldest = min((seen.get(item["id"], now) for item, _ in left), default=None)
    return {
        "left": len(left),
        "byBand": by_band,
        "oldestWaitingSince": None if oldest is None else
        time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(oldest)),
        "spentTodayUsd": round(spend.spent(now), 4),
        "dayBudgetUsd": spend.budget_usd,
        "overBudget": over_budget,
    }
