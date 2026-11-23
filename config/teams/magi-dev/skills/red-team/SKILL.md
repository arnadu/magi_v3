---
name: red-team
description: Attack one trust boundary as each attacker who can reach it, log every attempt with what stopped it, and back every claimed break with a reproduction that ran. A separate turn from the change review; "no findings" without the attack log is not a result.
---

# Red team (appsec)

A change review asks "is each control in place?" and tends to find what it expects. This turn
asks the opposite question: **how would I get through?** You succeed when something breaks.
Every attempt you make is logged, so a pass is a list of attacks that failed, each with the
reason it failed.

Run it when your schedule says so: the oldest line of your red-team queue
(`$SHARED_DIR/reports/security/red-team-queue.md`, filled by `change-review`), otherwise the next
boundary in your rotation (keep the rotation in the review-state section of your mental map).
Remove the line from the queue when its report is written.

## Before you start: don't read your own verdicts

Your earlier reports on this code, and the threat model's mitigation column for this boundary,
say what is supposed to stop you. Reading them first makes you test what they claim instead of
looking for what they missed. Until your attack log is written, read only:
- the code of the boundary, at the commit you are attacking (a worktree, `repo-workspace`);
- `docs/security/trust-boundaries.md`, for the attackers: who they are, what they hold, what
  they can reach and write;
- the ADR that designed the boundary, for what it is meant to do.

Afterwards, compare your log with the threat model's rows and your earlier reports: a
mitigation they claim that you could not confirm is drift, and goes in your report.

## Procedure

1. **The boundary and its attackers.** Name the boundary (threat model id), the commit, and
   every attacker from `trust-boundaries.md` who can send it input or write something it reads:
   a prompt-injected agent, a teammate agent, another tenant, the internet, a background job.
   For each, write what it controls: request fields, files and folders, environment, timing,
   content an agent or the operator will later open.

2. **Enumerate attacks.** For each attacker, go through every STRIDE category and, for code that
   handles input, the CWE Top 25; for anything an LLM reads or decides, the OWASP Top 10 for LLM
   applications. Write each candidate attack as a concrete path: what the attacker does, through
   which input, aiming at which effect. Think beyond the request itself: what the target reads
   from disk, the environment it inherits, what runs later on what it wrote, two requests in an
   unexpected order. A category that cannot apply gets one line saying why.

3. **Try each attack**, cheapest proof first:
   - **Run it** when you can reproduce it without touching anything shared: a script in your
     own workdir, against a copy of the code or of the mechanism (the same interpreter, the same
     flags, the same file layout). Python, bash, git and node (without the repository's
     dependencies) are available. Save the script in your report folder.
   - **Read it** when it cannot be run here (TypeScript that needs the repository's
     dependencies, a deployed setting): follow the path to the line that stops it. A result
     reached by reading says so.
   - **Never** attack the running mission, its daemon, other agents' files, the network, or a
     deployment. A probe of something live is a question for the user, with the exact command.

4. **Log every attempt** in the attack log (below), one row per attack, with a verdict and
   evidence that `checklist.py summary` accepts:
   - `pass`: blocked. Evidence: the file:line that stops it, and either the command and output
     that showed it (`ran:`) or `read:`.
   - `fail`: broken. Evidence: the reproduction that ran, its command and output. It is a
     finding (`security-judgement`, `security-reporting`): severity, and a proposed regression
     test in the hand-off.
   - `unverifiable`: you think it works but could not run it. Evidence: why, and the test that
     would settle it, written out in full (a vitest test for TypeScript) in the hand-off. It is
     a hypothesis, labelled as one, never a finding.
   - `n/a`: the attack cannot apply. Evidence: why.

5. **Variants.** For every `fail`, look for the same mistake at the other boundaries and in the
   code like it (`security-judgement`, variant analysis).

6. **Report**: `$SHARED_DIR/reports/security/YYYY-MM-DD-red-team-<boundary>.md`: the boundary,
   the commit, the attackers, the attack log, findings, hypotheses with their tests, drift, and
   the last lines of `checklist.py summary` and `check-citations.py`. The verdict is one of
   "broken" (a finding), "held against N attacks" or "incomplete" (with the rows still open).
   "Held" with fewer than five attempts per attacker is "incomplete".

## Attack log

Copy this into the report and add one row per attempt:

```markdown
| Id | Attacker | Attack: what, through which input, aiming at what | Verdict | Evidence |
|---|---|---|---|---|
| RT-1 | | | ? | |
```

## Budget

An attack pass costs several change reviews. Spend it on what changed in a boundary, and on the
attacks whose effect would matter most: running as another identity, reading another tenant's
data, reaching a secret, acting without the operator's confirmation.
