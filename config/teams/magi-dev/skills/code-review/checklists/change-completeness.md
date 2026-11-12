# Change completeness checklist

For each commit you read in depth: what should come with a change of this kind, and is it
there? Most rows are "if the change does X, it also needs Y"; mark them `n/a` with a one-line
reason when the change doesn't do X. A missing companion is a finding even when the code
itself is correct. Drawn from Google's code-review guide and the repository's own working rules.

Verdicts: pass · fail · missing · n/a · unverifiable — each with evidence. Work with
`checklist.py` (working-agreements). For a batch of small commits, one checklist per batch is
fine; say which commits it covers.

| Id | Area | Check | Verdict | Evidence |
|---|---|---|---|---|
| CR-01 | Correctness | Empty, missing, null and very large inputs are handled | ? | |
| CR-02 | Correctness | Duplicates, retries and repeated delivery are handled (idempotent where it can run twice) | ? | |
| CR-03 | Correctness | Concurrency: two runs, two tabs or two agents at once cannot corrupt state (compare-and-set, unique index, lock) | ? | |
| CR-04 | Correctness | A crash halfway leaves a consistent state, or the next start repairs it | ? | |
| CR-05 | Correctness | Time: time zones, clock skew, ordering by timestamp, expiry boundaries | ? | |
| CR-06 | Correctness | Units and limits are explicit (ms vs s, bytes vs MB, dollars vs cents) | ? | |
| CR-07 | Failure | Every external call (HTTP, LLM, Fly, Mongo, subprocess) has a timeout and an abort, and its failure is handled, not swallowed | ? | |
| CR-08 | Failure | Every error that reaches a log says what failed, on what input, and the consequence | ? | |
| CR-09 | Failure | A failure is visible to whoever must act on it (the operator, a copilot, the calling agent), not only logged | ? | |
| CR-10 | Closed loop | Every asynchronous hand-off (a card, a job, a schedule, a message to another agent) has a way for the requester to learn the outcome | ? | |
| CR-11 | Tests | A test fails without this change (bug fixes: the test reproduces the bug first) | ? | |
| CR-12 | Tests | The failure paths and edge cases above have tests, not only the happy path | ? | |
| CR-13 | Tests | Tests assert behaviour (state, output), not just that code ran; unit tests are offline and deterministic | ? | |
| CR-14 | Tests | If the change crosses components (route + tool + skill, API + cockpit), something tests the whole path, not each part alone | ? | |
| CR-15 | Data | A changed stored shape comes with a migration or a reader that accepts both shapes, and a test with an old-shape document | ? | |
| CR-16 | Data | A new collection or field goes through the canonical stored types (`agent-config/src/stored/`) | ? | |
| CR-17 | Security | New input is validated where it enters; new paths, subprocesses, queries and HTTP calls use the house helpers (see appsec's checklist for detail; flag, don't judge) | ? | |
| CR-18 | Security | New routes and tools check ownership and authentication | ? | |
| CR-19 | Limits | New LLM-driven or recurring work is covered by spend caps, per-turn limits and timeouts | ? | |
| CR-20 | Operations | A new background loop, schedule, write or dependency has its failure modes in `docs/operational-resilience.md` | ? | |
| CR-21 | Docs | A new environment variable is in the env catalog and `docs/env.md` | ? | |
| CR-22 | Docs | A new or changed agent tool is in the spec's tool tables and its description says what it does and when to use it | ? | |
| CR-23 | Docs | A decision between alternatives has an ADR; a new trust boundary is in the threat model | ? | |
| CR-24 | Parity | A new operator capability in the cockpit has a copilot equivalent where a copilot would need it, and the reverse | ? | |
| CR-25 | Instructions | If a tool, route or workflow changed, the skills and prompts that describe it were updated in the same commit, and still describe the best path | ? | |
| CR-26 | Cockpit | If an API response changed, the cockpit code that reads it was updated | ? | |
| CR-27 | Design | The change reuses the existing helper for the job instead of adding a parallel one (search before accepting a new one) | ? | |
| CR-28 | Design | Dependencies point the right way (no worker code importing control-plane internals, no cycles) | ? | |
| CR-29 | Design | Each fact still has one home (no copied constants, no restated types or status) | ? | |
| CR-30 | Structure | No file over the size thresholds without a reason; no new function over 80–100 lines with separable phases | ? | |
| CR-31 | Cleanup | No dead code, leftover debug output, commented-out code or unexplained TODO | ? | |
| CR-32 | Cleanup | A removed feature is removed everywhere: code, tests, docs, skills, prompts, cockpit | ? | |
| CR-33 | Naming | Names say what things are; one term for one thing across code, docs and UI | ? | |
| CR-34 | Rollout | Missions running an older image or config keep working until they are resumed; anything that needs a resume or a migration is said in the commit | ? | |
