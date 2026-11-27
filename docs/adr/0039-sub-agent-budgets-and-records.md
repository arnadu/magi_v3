# ADR-0039: Sub-agents end within their budget, and are recorded and charged wherever they run

**Status:** Accepted (2026-11-27).
**Relates to:** ADR-0017 (`llm-call.recorded`, `llm-call.cost-counted`), ADR-0036 (the catalog:
`turn.persisted-per-step`, `turn.sub-agent-bounded`), COST-1 (tool-side calls metered against
the turn).

## Context

Investigate and Research run a sub-agent: an inner loop with its own model calls and tools,
started either by an agent's tool call in a turn or by a background job through the Tool API.
MAGI DEV's first alert-triage runs (`magi-dev-1`, 2026-11-27) showed three gaps on the job path:

- **Not recorded, not charged.** The Tool API's meter dropped every call that named no model,
  and the inner loop never names one, so a job's sub-agent calls reached neither `llmCallLog`
  nor the agent's cost nor the mission cap. Its steps were stored nowhere: the Tool API passed
  no step hook. Each hook was optional, so leaving one out compiled.
- **No ending but the kill.** A sub-agent ended when its turns ran out (Investigate then gave it
  one extra turn to answer) or when something killed it. Investigate could run 15 minutes; the
  job running the pipeline was killed at 30, and what the sub-agents had done was lost.
- **No gate.** A job's sub-agent was checked against the spend-cap pause only when the call
  began.

## Decision

1. **The hooks are required.** A sub-agent is built with `SubAgentHooks`
   (`tools/sub-agent-hooks.ts`): store each step, meter each call, gate each call. Investigate
   and Research cannot be constructed without them, so a caller that forgets is a compile error.
   - In a turn: steps go to `conversationMessages` under the turn (as before), calls are metered
     against the turn, and the gate waits while the cap holds.
   - In a job: steps go to `conversationMessages` under the job's agent at turn 0 (outside any
     turn, as the meter logs these calls), with `parentToolUseId` (the Tool API call) and
     `jobId`, so they stay out of the agent's own history; calls are logged, charged to the
     agent's lifetime cost and checked against the cap; the gate stops the sub-agent at its next
     call while the cap holds, since an HTTP call from a job cannot wait for hours.
   - The log-only meter takes the loop model as a required argument, used when an event names
     none.
2. **A sub-agent has a time budget as well as a turn budget, and a last step.** When either is
   about to run out, `runInnerLoop` (`finalStep`) makes the next call the last: a notice is
   stored as a user message ("this is your last step: answer from what you have, and say what
   you could not check and why"), the call is offered no tools, and the loop ends after it.
   Investigate returns the answer marked `incomplete: {reason, note}`, the note being what the
   sub-agent wrote before its JSON; a caller treats it as not a verdict. Budgets: Investigate
   5 minutes, Research 6 minutes; the Tool API's runtime limit stays above them only as a
   backstop (10 minutes for each).
3. **No extensions.** A sub-agent cannot ask for more time, and a job's 30-minute limit is
   unchanged; a review pipeline stops starting investigations before it and defers the rest.

## Alternatives considered

- **Let a job ask for a longer limit.** It would have let a slow positive triage item (four
  investigations) finish in one run. Rejected: it treats the symptom; a sub-agent that may take
  15 minutes per question is the problem, and a limit an agent sets is one more value to bound
  and check.
- **Kill on time and keep only what was stored.** With every step stored, nothing would be lost,
  but the caller would get no answer and no account of what was left undone; the last step
  costs one call and gives both.
- **A separate collection for job sub-agent steps.** Clearer, but a second home for the same
  kind of record; `conversationMessages` already keeps a turn's sub-agent steps apart from the
  agent's history by `parentToolUseId`.

## Consequences

- Every Investigate or Research call, from a turn or a job, is recorded step by step, logged and
  charged to its caller; the catalog's `turn.persisted-per-step`, `llm-call.recorded` and
  `llm-call.cost-counted` name what enforces them.
- An investigation answers within about 5 minutes plus one call. A hard question may come back
  `incomplete` every time; the review pipeline records it as such (not stored as a verdict), and
  the agent reports repeats as a calibration problem rather than investigating it itself.
- CreateImage's sub-agent is unchanged: the platform, not the model, assembles its result, with
  a partial manifest when a limit or abort stops it.
