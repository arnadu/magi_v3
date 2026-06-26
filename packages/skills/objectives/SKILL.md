---
name: objectives
description: |
  How you track progress against the mission's objectives. You are assigned
  tasks and own KPIs; keep their status current with the scripts below. Your
  current tasks, owned objectives, and KPIs are injected into your mental map
  each turn (the "Your objectives" section) — you do not need to fetch them.
---

# Objectives, tasks & KPIs

The mission is organised as a tree of **objectives** (broken down into
sub-objectives) with **tasks** at the leaves and **KPIs** that measure success.
This is the shared source of truth the operator watches — keeping it current is
how the operator knows the mission is on track, so update it as you work.

- A **task** is assigned to one agent and has a status. You update the status of
  tasks assigned to you.
- An **objective** has a supervisor **owner** accountable for its status + KPIs.
- A **KPI** measures an objective. If you **own** a KPI, you keep its value
  current with `record-kpi`.

Your tasks, owned objectives, and owned KPIs (with any that need attention) are
**injected into your mental map every turn** under "Your objectives" — read them
there; you do not query a board. Organise the rest of your mental map around them.

## Updating your work

The scripts append to the shared store — run them via `Bash`. They read your
identity and the store location from the environment (`AGENT_ID`, `SHARED_DIR`),
so you never pass paths or your own id.

**Change a task's status** (the most common action — do it as you work):

```bash
bash $SHARED_DIR/skills/_platform/objectives/scripts/task-update.sh \
  --id TASK-abc123 --status in-progress
```

`--status` is one of `open | in-progress | blocked | completed | deferred | cancelled`.
Other flags: `--assignee <agentId>`, `--priority <p>`, `--deadline <date>`,
`--budget <usd>`, `--note "<text>"`.

**Record effort for cost tracking.** When a turn's work spans more than one task,
add `--effort <n>` to each task you update — a relative weight (default 1) for how
much of *this turn* went to that task. The system splits your turn's cost across
the tasks you updated, by these weights. You only express *relative* effort
("most of this turn was TASK-A"), never dollars:

```bash
... task-update.sh --id TASK-a --status in-progress --effort 3
... task-update.sh --id TASK-b --status blocked     --effort 1
```

**Add a task** (id auto-generated unless you pass `--id`):

```bash
bash $SHARED_DIR/skills/_platform/objectives/scripts/task-add.sh \
  --title "Pull NVDA prices" --objective OBJ-1.1 --assignee data-scientist --priority high
```

**Record a KPI you own:**

```bash
bash $SHARED_DIR/skills/_platform/objectives/scripts/record-kpi.sh \
  --kpi K4 --value "38" --note "records reconciled so far"
```

A numeric `--value` is stored as a number; otherwise as text (e.g. `met`,
`partial`, `unmet`). If your mental map flags an owned KPI as needing an update,
run `record-kpi` for it.

## Rules

- **Do not commit anything.** The daemon checkpoints the shared folder every turn
  (see `git-provenance`). These scripts only append to the store.
- **Keep status honest and current.** The operator manages by exception from this
  data; a stale `in-progress` that's really blocked hides a problem.
- Objectives and KPI *definitions* are authored by the operator/copilot — you
  record task status and KPI *values*, you don't redefine the tree.
