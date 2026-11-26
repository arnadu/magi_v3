# ADR-0038: Tasks as work orders

**Status:** Accepted (2026-11-26).
**Relates to:** ADR-0019 (the objectives store), ADR-0036 (the catalog: `task.done-checked`,
`task.terms-guarded`), the editable templates on the roadmap (catalog-review decision 6), which
will carry each agent's allocated tasks in this shape.

## Context

An agent learned of its work from the "Your objectives" section of its mental map, which showed
each open task's id, title and status, and nothing else. A task had no field for what to do,
for when it was done, or for the standard the work had to meet; objectives had a `description`
the agent never saw. Instructions therefore travelled in messages, which reach later sessions
only as a summary, and agents guessed: in MAGI DEV, appsec's "Ongoing change reviews" task
became a catch-all for whatever it judged to be its duties, and its completion notes claimed
results nobody had checked.

## Decision

A task may be a **work order**, with four optional fields (`TaskWorkOrderSchema`,
`agent-config/src/objectives-task.ts`, shared with the future template store):

- `instructions` (≤ 2,000 characters) and `doneWhen` (≤ 500), shown to the assignee every turn
  with the task, as is each owned objective's `description`;
- `skills` (≤ 6): the skills the work must follow;
- `check`: a script that decides `doneWhen` where code can.

The platform enforces it (`objectives/work-order.ts`, called by `AddTask` and `UpdateTask`):

1. **Required skills come from the operator.** Only team and platform skills can be required,
   and the assignee must have each one (not in its `disabledSkills`). Skills agents write can be
   rewritten by agents, so they never set a standard.
2. **Starting hands over the standard.** Moving a task to `in-progress` returns the required
   skills' full text in the tool's answer (their paths when longer than 18,000 characters), so
   the standard is in the agent's context when the work begins.
3. **Completing meets the finish line.** With a check, `completed` runs it as the agent
   completing the task, through the isolated shell every agent command uses (its OS user, its
   workdir, no secrets), for at most 120 seconds: exit 0 records the completion with the
   script's output as evidence; anything else refuses it. Without a check, a task with a
   `doneWhen` needs a note saying how it was met. The operator and the mission copilot may
   complete a task otherwise, with a recorded reason.
4. **The terms belong to whoever assigned the work.** `doneWhen`, `check` and `skills` are
   changed only by the task's creator, its objective's owner or the mission copilot. A check
   script must lie inside a team or platform skill, which agents cannot write, so an assignee
   cannot rewrite the check it is held to.

## Alternatives considered

- **Instructions in a linked file** (a path in the task). Keeps the store small, but the file
  can be moved or edited by agents, and the agent must remember to open it; inline text is
  shown every turn. Long background stays in skills, which the task names.
- **Checking skill use by watching for a read of `SKILL.md`.** Fragile (an agent reads files in
  many ways) and proves only that a file was opened. Handing the text over on start is
  deterministic.
- **Requiring the skills at completion instead of at start.** Too late: the standard matters
  while the work is done.
- **Running checks as the daemon.** The daemon holds every secret and can read every agent's
  files; a check needs neither. Running it as the agent gives it exactly what the agent could
  have shown by hand.

## Consequences

- Code can check the finish line only where a script can; that the work followed a skill's
  standard is still judged by the checks the skills carry (report gates, citation checks) and
  by people.
- A task with long instructions costs tokens every turn it is open; the caps and showing
  deferred tasks by title only bound it.
- A check that hangs is killed at 120 seconds and the completion refused; nothing is recorded.
- Templates' allocated tasks (editable templates) are to use this schema, so a template can
  ship its tasks and the check scripts and skills they name together.
