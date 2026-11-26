---
name: objectives
description: |
  How you track progress against the mission's objectives. You are assigned
  tasks and own KPIs; keep their status current with the tools below. Your
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
  current with `RecordKpi`.

Your tasks, owned objectives, and owned KPIs (with any that need attention) are
**injected into your mental map every turn** under "Your objectives" — read them
there; you do not query a board. Organise the rest of your mental map around them.

## Updating your work

Four tools write to the shared objectives store. They already know your
identity and mission — you never pass your own agent id.

**Change a task's status** (the most common action — do it as you work):

```
UpdateTask(id: "TASK-abc123", status: "in-progress")
```

`status` is one of `open | in-progress | blocked | completed | deferred | cancelled`.
Other fields: `assignee`, `priority`, `deadline`, `budgetUsd`, `note`.

**Record effort for cost tracking.** When a turn's work spans more than one task,
pass `effort` on each `UpdateTask` call — a relative weight (default 1) for how
much of *this turn* went to that task. The system splits your turn's cost across
the tasks you updated, by these weights. You only express *relative* effort
("most of this turn was TASK-A"), never dollars:

```
UpdateTask(id: "TASK-a", status: "in-progress", effort: 3)
UpdateTask(id: "TASK-b", status: "blocked",     effort: 1)
```

**Add a task** (id auto-generated unless you pass one):

```
AddTask(title: "Pull NVDA prices", objective: "OBJ-1.1", assignee: "data-scientist", priority: "high")
```

**Record a KPI you own:**

```
RecordKpi(kpi: "K4", value: "38", note: "records reconciled so far")
```

A numeric `value` is stored as a number; otherwise as text (e.g. `met`,
`partial`, `unmet`). If your mental map flags an owned KPI as needing an update,
call `RecordKpi` for it.

**Allocate unattributed cost (only when prompted).** Cost is normally attributed
to your tasks automatically from your `UpdateTask` calls. If — and only if —
your mental map flags **unattributed cost**, call `Allocate` to say where it
should go (relative weights; targets are task ids, objective ids, or `overhead`):

```
Allocate(key: "TASK-1:60,overhead:40")
```

## Work orders

A task can carry its own instructions, so that whoever does it does not have to guess:

```
AddTask(id: "SEC-T6", title: "First triage pass", objective: "SEC-4", assignee: "appsec",
  instructions: "After each triage run, verify what survived. Inputs: review/state/runs/ ...",
  doneWhen: "A run has no deferred item and the verification queue is empty.",
  check: {script: "alert-triage/scripts/check_first_pass.sh"},
  skills: ["alert-triage", "security-judgement"])
```

- `instructions` (up to 2,000 characters): what to achieve and why, the inputs with their
  paths, and the limits. Write it for someone starting cold.
- `doneWhen` (up to 500): the finish line, stated so it can be checked.
- `skills` (up to 6): team or platform skills the work must follow. They are refused if the
  assignee does not have them. When the assignee starts the task (`in-progress`), the
  answer carries their full text: do the work to their standard.
- `check`: a script inside a team or platform skill (`<skill>/<path>`), with optional `args`.
  When the task is completed, it runs as the agent completing it, in that agent's workdir
  (with `WORKDIR`, `SHARED_DIR`, `AGENT_ID`), for at most 120 seconds. Exit 0 means done,
  and its output is recorded as the evidence; any other exit refuses the completion and
  shows the output. A check reads; it never changes anything.

**Completing a work order.** With a check, `UpdateTask(status: "completed")` runs it. Without
one, a task with a `doneWhen` needs a note saying how each condition was met, with paths.
Only the operator and the mission copilot may complete a task without meeting its finish
line, with `override: "<reason>"`, which is recorded.

**Who sets the terms.** `doneWhen`, `check` and `skills` are changed only by the task's
creator, its objective's owner or the mission copilot. If you are assigned a task whose terms
look wrong, say so to whoever assigned it; you may still update its `instructions` with what
you learn.

## Rules

- **Keep status honest and current.** The operator manages by exception from this
  data; a stale `in-progress` that's really blocked hides a problem.
- Objective and KPI *definitions* (the tree itself) are authored by the
  operator/copilot — you record task status and KPI *values*, you don't
  redefine the tree. There is no tool for that; if the tree itself needs to
  change, tell your supervisor or the mission copilot.
