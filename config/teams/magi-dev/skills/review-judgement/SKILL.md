---
name: review-judgement
description: How a code-review finding is labelled, graded and justified — Conventional Comments labels, blocking or not, the evidence a finding needs, refuting yourself first, the "improves overall code health" bar, and turning a repeated finding into a proposal for automatic enforcement.
---

# Review judgement

## The bar

Approve a change when it improves the overall health of the code, even if it isn't perfect.
Block only what makes it worse: a bug, a missing test for risky behaviour, a broken house rule,
a new parallel shape for stored data. Everything else is a suggestion.

## Labels (Conventional Comments)

Every finding carries one label and a blocking flag:

| Label | Meaning | Blocking? |
|---|---|---|
| `issue` | Something is wrong: a failure scenario exists | Usually blocking |
| `suggestion` | A concrete improvement, with the change | Non-blocking unless a house rule is broken |
| `question` | You suspect something but couldn't show it | Non-blocking |
| `nitpick` | Trivial; only if not caught by the linter | Non-blocking; prefer to omit |
| `praise` | Something worth repeating elsewhere | — |

Also tag each finding with its quality-model criterion (Q1–Q12).

## Evidence

An `issue` states the **failure scenario**: the input or sequence of events, and the wrong
result. "Could be a problem" is a `question`. Point to `file:line` and quote the line.

## Refute it first

Before writing an `issue`, try to prove yourself wrong:
- a guard upstream or in the caller? (read the callers, `grep -rn` the function name)
- a test that already covers the case? (search the tests for the function)
- a documented decision that makes it intended? (ADRs, an accepted finding, a reasoned
  `tripwires.allow` or `structure.allow.json` entry)
Record what you checked. If the refutation succeeds, drop it or downgrade it to a `question`.

## Repeated findings become enforcement

The October 2026 audit found that rules which nothing checks are ignored. So when the same kind
of finding appears a **second** time (in your register of findings, across reports), propose a
deterministic check in the same report: a tripwire pattern (`scripts/audit/tripwires.sh`), a lint
rule, a ratchet, or a contract test. Give the pattern, where it would apply, and how many hits it
has today. Keep a "proposed enforcement" list in your mental map so you can tell what has been
proposed already.

## Severity in the report

Order findings: blocking `issue`s, then non-blocking `issue`s, then `suggestion`s, then
`question`s. A report with no blocking finding says so in its first line.
