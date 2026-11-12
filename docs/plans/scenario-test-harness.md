# Scenario test harness — plan and requirements

Status: **proposed 2026-11-13, not scheduled.** Roadmap: "Near-term candidates". Related:
the evaluation harness for agent behaviour ([#45](https://github.com/arnadu/magi_v3/issues/45)),
seeded defects ([#72](https://github.com/arnadu/magi_v3/issues/72)) and the MAGI DEV agents'
known-answer tests ([magi-dev-requirements.md](magi-dev-requirements.md)). One harness serves
all three.

## Why

In November 2026 the operator asked the control copilot to set up a new mission. It took about
ten confirmations over five hours, ran the template's agents for a while because a resume was
confirmed before the config change, and left the mission with the wrong name. The causes were
basic, and every one sat **at a seam between parts that each worked**:

- the copilot had tools to edit and launch a draft, but none to create one;
- confirming a card worked, but nothing told the copilot it had happened, so it went quiet;
- a config was validated only when the operator confirmed it, so errors surfaced in the
  operator's hands;
- the copilot's skill was internally consistent, and described the slow path.

None of these could be caught by the existing tests:

| Layer | Today | Blind to |
|---|---|---|
| Unit, ~1,350 tests | Modules in isolation; every push | Anything spanning modules |
| Integration without an LLM, ~210 tests | Routes, persistence, copilot tools called one at a time | Workflows |
| Integration with an LLM, ~25 tests | The agent runtime: loop, multi-agent, reflection, skills, tools, jobs, objectives, limits | Copilot behaviour |
| Copilots with an LLM | One test: the control copilot *proposes* a template launch, then stops | Multi-step workflows; the mission copilot entirely |
| End to end | None | Every operator story |

CI runs only the unit tests; the integration suite runs by hand, against the shared dev
database.

## What a scenario is

An **operator story played against the copilot**, with the test standing in for the operator:
it sends the request, confirms or dismisses each card the way the operator would, answers
questions with scripted replies, and at the end checks the **resulting state** — never the
wording. It also measures **friction**: cards shown, operator messages needed, wall time and
cost.

## Requirements

**R1. Two tiers.**
- **Seam tests (scripted model).** The copilot's model is replaced by a script of tool calls.
  Deterministic, fast, free: they test the plumbing — every tool a workflow needs is reachable,
  proposals are checked when proposed, a confirmation produces an outcome message that wakes
  the copilot, cards arrive in a safe order. Run on every push, in the unit suite.
- **Scenarios (real model).** Test the instructions: skills and prompts lead the model down the
  right path. Nondeterministic, cost money: run nightly or before a release, on a cheap model
  set per run.

**R2. Isolation.** Scenarios run against a dedicated database (a database name of their own,
or a local `mongod`), never the shared dev data, with `LOCAL_EXECUTION` so a launch writes
local files instead of starting a Fly machine. Every scenario cleans up after itself.

**R3. State assertions, not wording.** A scenario passes on facts: documents in the database,
cards proposed and their order, files written, messages sent and to whom. Never on how the
model phrased something.

**R4. Friction budgets.** Each scenario declares maximums for cards, operator replies, wall
time and cost; exceeding one fails the scenario. "Ten confirmations" becomes a failing test.

**R5. Repeats and trend.** Real-model scenarios run 2–3 times; a scenario passes on a majority.
Each run appends a line to a results file (scenario, model, prompt/skill commit, pass/fail per
assertion, friction numbers, cost), so a change in prompts or models shows up as a trend.

**R6. Regression rule.** Every workflow bug the operator finds in live use becomes a scenario
or a seam test before it is closed.

**R7. CI.** Seam tests gate every push with the unit suite. Real-model scenarios run on a
schedule (nightly) and before `promote.sh`, reporting to the operator rather than blocking.

## Scenarios, first set

**S1 — Create a small mission (control copilot).** The request:

> Create a mission called **Haiku Desk**: an **editor** who reports to me and a **poet** who
> reports to the editor. Each day the poet writes one haiku about the weather to
> `haiku/YYYY-MM-DD.md` and the editor reviews it. Use a cheap model; cap it at **$2**.

Passes when: a draft exists with exactly these two agents and supervisor tree; every prompt has
`{{mentalMap}}`; the poet's prompt names the `haiku/` path; cap ≤ $2 and a known model is set;
objectives are saved, each with an owner and a KPI; the daily duty has a schedule or a first
task to create one; **one** launch card; after it is confirmed the mission is running and the
copilot messages the operator unprompted. Budgets: 2 cards (launch, schedule), 1 operator
reply, 10 minutes, $0.50.
A later stage lets the local daemon run the first turn and checks that `haiku/` gets a file.

**Control copilot, next:**

| # | Story | Checked by |
|---|---|---|
| S2 | "Add a fact-checker to Haiku Desk" | Cards in order suspend → config → resume; no resume before the config executed; final roster |
| S3 | Rename, change the model, raise the cap | The listed name, `mission.model`, `set_mission_budget` |
| S4 | "Remind the editor every weekday at 9" | A `create_schedule` card with the right cron and recipient |
| S5 | The operator dismisses a card | Acknowledged; not re-proposed unchanged |
| S6 | A confirmed card fails | The copilot is told, fixes the cause, re-proposes once |
| S7 | A relayed hard anomaly | Reported to the operator; a card only when warranted |
| S8 | The daily resource report | One summary; already-known flags not repeated |
| S9 | "File a bug about X" | A GitHub card with the provenance label; not executed |

**Mission copilot:**

| # | Story | Checked by |
|---|---|---|
| M1 | "What is the poet doing?" | Reads the teammate's state; the answer names its actual current task |
| M2 | "Give the poet a task to …" | `AddTask` with the right assignee and objective |
| M3 | "Make the editor stricter about …" | A config change to that agent's prompt only, the rest intact |
| M4 | A teammate loops (seeded anomaly) | Pauses or coaches it, and reports to the operator |
| M5 | A teammate asks for more memory | `RequestResourceUpgrade` within its bounds |
| M6 | Its soft-anomaly digest arrives | One summary; nothing in the operator's inbox |

## Design

```
eval/
  scenarios/<id>.yaml   # request, scripted operator replies, card policy, assertions, budgets
  runner.ts             # boots an in-process control plane (+ daemon for mission scenarios),
                        # plays the operator, collects cards, messages, state, cost
  assertions.ts         # state checks: drafts, roster, cards and their order, files, messages
  scripted-model.ts     # tier 1: a model that replays a script of tool calls
  results.jsonl         # one line per run (R5)
```

- **The operator stand-in** confirms every card unless the scenario's policy says otherwise
  (dismiss, or confirm only some types), and answers questions from a list of canned replies
  matched by keyword; an unexpected question fails the scenario.
- **Copilot turns** run through the same runtime the control plane uses; the waker is real, so
  "the copilot was woken by the outcome message" is observed, not assumed.
- **Mission-copilot scenarios** start a local daemon on a seeded mission (fixed team, fixed
  mental maps, seeded mailbox or anomalies).
- **Model and repeats** are run parameters; the same scenario set doubles as a model
  benchmark for the copilots, as the known-answer tests do for the MAGI DEV agents.

## Phasing

| Step | Content | Size |
|---|---|---|
| 1 | Scripted-model seam tests for the creation and change workflows (S1, S2, S5, S6 plumbing); in the unit suite | 1 day |
| 2 | Runner, isolated database, operator stand-in, assertions, results file; S1 with a real model | 1.5 days |
| 3 | S2–S9 | ~2 days |
| 4 | Mission-copilot scenarios M1–M6 (local daemon on a seeded mission) | ~2 days |
| 5 | Nightly CI job and the pre-promote run; the MAGI DEV known-answer tests moved onto the same runner | 1 day |

## Blind-spot review: what to ask so this kind of gap is found earlier

The code reviewer and two audits read the code module by module and found nothing here,
because nothing was wrong *inside* a module. The questions that would have found it are about
journeys, reachability and loops, and belong in the reviewers' periodic passes:

1. **Journey coverage.** List the operator's main journeys (create a mission, change one,
   recover one, schedule work, read results). For each: which test plays it end to end? A
   journey with no such test is a finding.
2. **Reachability and parity.** For each capability, can the intended actor reach every step?
   Compare what the operator can do in the cockpit with what each copilot can do through its
   tools, and the reverse. (The cockpit could create a draft; the copilot could not.)
3. **Closed loops.** For every asynchronous hand-off (a card, a background job, a schedule, a
   request to another agent), who learns the outcome, and how? A hand-off whose result reaches
   nobody is a finding.
4. **Instructions describe the best path.** Do the skills and prompts route each journey
   through the shortest safe path the code offers, not just a path that exists? Read them as
   the agent would, step by step against the tools.
5. **Friction.** How many confirmations, messages and minutes does each journey take? Compare
   with the minimum the safety rules require.
6. **Test layers.** Which layer has no tests at all (here: copilot workflows), and which tests
   never run in CI?
7. **How bugs were found.** For each recent bug, was it found by a test, a reviewer, or the
   operator in live use? Bugs found by the operator point at missing scenarios (R6).

The code reviewer gets these as a quality-model criterion (journey coverage and closed loops)
and a quarterly journey review; the whole-repo `/sprint-audit` gets a journeys auditor beside
its specialists.
