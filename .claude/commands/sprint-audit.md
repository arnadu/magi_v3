---
allowed-tools: Read, Glob, Grep, LS, Agent, Bash(git log:*), Bash(git ls-files:*), Bash(node scripts/audit/*), Bash(bash scripts/audit/*), Bash(npm run verify:*), Write
description: Whole-repo sprint-end audit — seven specialist auditors in parallel, an independent verifier that tries to refute each finding, a report and a metrics trend
---

You are running the sprint-end audit for MAGI V3: a read-only, whole-repo review by
specialist auditors, followed by an independent verification pass. It exists because the
October 2026 third-party audit found ~150 issues that diff-scoped reviews had missed (its
root causes: reviews look at diffs while defects are repo-wide patterns; LLM-facing text and
docs are not treated as code; the same author writes and reviews). Do not narrow it to the
current branch's changes.

Arguments: `$ARGUMENTS` — the sprint label for the report file (e.g. `28f`). If empty, use the
highest active sprint in CLAUDE.md's Sprint Roadmap.

PROJECT CONTEXT:

```
!`cat CLAUDE.md`
```

TRUST BOUNDARIES (the boundary auditor starts here):

```
!`cat docs/security/trust-boundaries.md`
```

OPEN AND RECENTLY FIXED FINDINGS (to re-verify, not to suppress):

```
!`cat docs/security/findings.md`
```

DETERMINISTIC LAYER — run first and include its result in the report:

```
!`bash scripts/audit/tripwires.sh 2>&1 | tail -15; node scripts/audit/structure-check.mjs 2>&1 | tail -5`
```

## Step 1 — Specialist auditors (in parallel)

Launch these seven auditors **in a single message** with the Agent tool
(`subagent_type: "general-purpose"`), each with only its own brief below plus this shared
instruction:

> You are auditing the MAGI V3 repository at its current HEAD, read-only. Audit the whole
> repository for your concern, not a diff. Report only defects you can point to in the code
> (file:line). A finding of severity High or Critical needs a reproduction — a command, a
> test, or a step-by-step trace through the code that shows the failure — or must be labelled
> INFERRED. Do not report style preferences, things already documented as accepted in
> `docs/security/findings.md` (A-xxx) or `docs/review/2026-10-consistency-matrix.md`, or
> deferred items that already have an open GitHub issue unless the code makes them worse.
> Return a Markdown table with exactly these columns:
> `| ID | Severity | Location | Claim | Evidence | Suggested fix | Confidence |`
> where ID is `<AUDITOR>-<n>` (e.g. `BND-1`), Severity is Critical/High/Medium/Low, and
> Confidence is VERIFIED (you reproduced or traced it end to end), INFERRED, or UNVERIFIED.
> If you find nothing, return the header row and the line "No findings."

| Auditor | Brief |
|---|---|
| **BND — Boundary** | Start from `docs/security/trust-boundaries.md`. For every privileged operation (file read/write, git, process spawn, `sudo`, outbound HTTP, MongoDB query) performed by the daemon or the control plane, trace each path, argument, URL, env value and query field back to who can write it. Flag any value written by a less-trusted actor (an agent, a tenant config, a web page, a mission machine) that reaches a privileged operation without containment (`safe-path.ts`), validation (Zod/TypeBox), or an allow-list. Include values whose writer changed over time (a config field that became tenant-supplied). |
| **SCH — Schema drift** | Start from `packages/agent-config/src/stored/` and the collection list in `packages/agent-config/CLAUDE.md`. For each collection, list every writer and every reader (grep the field names, including string paths in `$match`/`$group`/`$set`/projections and the cockpit's API types). Flag a field read that no writer sets, a field written that nothing reads, a type mismatch, or a query that bypasses the typed accessor. |
| **LLM — LLM-facing text** | Prompts (`packages/agent-runtime-worker/prompts/`), tool descriptions, `packages/skills/**`, `config/teams/**`, and text injected at runtime (anomaly messages, mental-map seeds, inbox formatting). Extract every tool name, script path, flag, file path, env var and JSON key the text tells a model to use; resolve each against the tool registry (`tool-catalog.ts`, the copilot tool factories), the filesystem and the code. Flag anything that does not exist, has a different shape, or describes retired behaviour. Also flag text that asks a model for a secret. |
| **DOC — Docs** | CLAUDE.md (root and package), MAGI_V3_SPEC.md, `docs/env.md`, the threat model, `docs/operational-resilience.md`, ADRs marked Accepted. Extract checkable claims (a command, a default, a behaviour, a limit, a file or function name) and verify each against the code. Flag every false or stale one. |
| **CST — Cost** | Every LLM call site (`runInnerLoop`, reflection, vision/OCR, Research, BrowseWeb/Stagehand, the copilots, anything calling `completeSimple` or a provider SDK). For each: is it metered into `llmCallLog` and the stats, does it count toward the mission cap and the copilot cap, can it run unbounded (loops, wake-ups, retries)? Flag feedback loops where an LLM call's own outcome triggers another call. |
| **STR — Structure** | Run `node scripts/audit/structure-check.mjs` and read `docs/code-structure.md`. Flag files or functions over the thresholds that are not allowlisted, allowlisted entries whose reason no longer holds, duplicated logic across modules, and dead exports (exported symbols with no importer outside tests). |
| **RES — Resilience** | Start from `docs/operational-resilience.md`. For each long-running loop, scheduled action, external call and persistence write in the daemon and the control plane: is there a timeout and AbortSignal, a restart path, overlap protection, a crash-safe write order, and does a failure fail closed or open? Flag gaps the FMEA does not record, and FMEA rows that no longer match the code. |

## Step 2 — Verification

Collect every row. Drop duplicates (same location and claim; keep the higher severity).
Then, for **every** Critical, High and Medium finding, launch a verifier agent (in parallel
batches, `subagent_type: "general-purpose"`) with only the finding row and this instruction:

> You are given one finding from an automated audit of the MAGI V3 repository. Your job is
> to refute it. Read the cited code and anything it depends on. Answer with one of:
> CONFIRMED (the defect exists as described — say how you checked), PARTLY (it exists but
> the severity or the claim is wrong — say what is right), or REFUTED (it does not exist —
> say why). Do not fix anything.

Low findings are kept as reported, marked "not verified".

## Step 3 — Report

Write `docs/review/sprint-<label>.md` (gitignored: it may hold reproduction payloads) with:

1. A summary: counts by severity after verification, how many were refuted, and the
   deterministic layer's result.
2. One table of surviving findings, most severe first:
   `| ID | Severity | Location | Claim | Evidence | Suggested fix | Confidence | Verifier |`.
3. A short list of refuted findings with the verifier's reason (they show where the auditors'
   briefs need tightening).

Then update `docs/review/metrics.json` (create it if missing; also gitignored) by appending
one entry: `{ "sprint", "date", "findings": { "critical", "high", "medium", "low" },
"refuted", "byAuditor": { "BND": n, … }, "tripwireAllowlist": n, "structureAllowlist": n }`.

Finally, in your reply: the summary, the surviving Critical/High findings in full, and the
recommended next actions (which findings to fix now, which to file as issues). Do not fix
code, open issues or change any other file — a human triages the report.
