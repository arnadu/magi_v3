# Code-quality plan (post-audit, Sprint 28f close-out)

Status: **agreed 2026-10-19**, not started. Follows the audit remediation
([audit-oct26-remediation-plan.md](audit-oct26-remediation-plan.md)), whose security and
reliability work is done; this plan covers its deferred readability and maintainability items
(WS-4 remainder, issue #84) and the code-quality issues filed alongside it.

## Why, and how this plan chooses

Size is not the target. Each step is ranked by **what has actually produced bugs**:

- **Stored data and code disagreeing on field names.** In one day this produced two production
  bugs: single-recipient PostMessage was missing from turn stats, and a test fixture still used
  the old `cost.total` shape. It also caused the $0 spend figures (#53). Nothing checks a reader
  against its writer.
- **The agent loop core.** The live loop bugs #55, #56, #64 and #65 all sat in `runAgent` and
  `runOrchestrationLoop`, the two longest functions with shared mutable state.
- **Debt that can quietly come back.** Empty catches, untyped casts, bare `console.error(e)` and
  copies of the default model id. These are small, but each one has hidden a failure before.

Rules that apply to every step:

- **A refactor commit moves code; it does not change behaviour.** Tests stay unchanged and pass
  before and after. Check the move with `git diff -M`. Keep each commit to about 600 lines or
  less. Where a module has no test through its public interface, write a characterization test
  first, in its own commit.
- **Every step leaves a gate tighter.** Lower an allowlist (`structure.allow.json`,
  `tripwires.allow`, the Biome complexity exemptions), raise a coverage floor, or add a contract
  test. Ratchets only go down.
- **One step is one or more commits on main**, each passing `npm run verify` (pre-push).
  Integration tests run at the end of steps 1, 2 and 4, which touch persistence and the loop.

## Baseline (2026-10-19)

| Measure | Now | Gate |
|---|---|---|
| Files over 600 lines | 39 | `scripts/audit/structure.allow.json` |
| Functions over 120 lines | `runAgent` 449, `runOrchestrationLoop` 419, `createMissionCopilotTools` 1008, copilot-tools factory 776, `TracePanel` 545, … | same |
| Files exempt from cognitive complexity 25 | 32 | `biome.json` override |
| T8 empty catch | 7 (allowance 11) | `tripwires.allow` |
| T9 `as any` / `as unknown as` / ts-ignore | 20 (allowance 20) | same |
| T11 history in comments | 107 (allowance 115) | same |
| T10 optional spend cap in schema | 1 (`loader.ts:163`; the creation sites set the default) | same |
| Bare `console.error(e)` | 7 | none yet |
| `"claude-sonnet-4-6"` literals in src | 7, in 6 files | none yet |
| Coverage floors, statements / branches / functions | agent-config 93/92/87; worker 51.5/81.3/70.1; control plane 47.2/87.5/73; cockpit none | `vitest.config.ts` |

## Steps

### 0. Tighten the ratchets to today's numbers (1 h)

T8 → 7, T11 → 107, so the slack can't be spent. T10: either make the schema field required
(defaults already applied at creation) or give the line a regex entry with its reason.

### 1. Typed stored documents — R-15 (≈1.5 d, issue #84)

**Goal:** a wrong field name on a stored document fails `tsc`, in the writer, in every reader
and in the cockpit.

- `packages/agent-config/src/stored/`: one interface per collection (`missionStats`,
  `agentTurnStats`, `llmCallLog`, `mailbox`, `scheduled_messages`, `missions`,
  `conversationMessages`, `copilotPendingActions`, the resource collections). Add a Zod schema
  only where documents are read from outside the writer's process. `agent-config` is already a
  dependency of both planes, so this is also the first slice of the shared domain package (#74).
- Typed accessors (`collections(db).missionStats` → `Collection<MissionStatsDoc>`) replace
  `db.collection("…")` with a string name. Add a tripwire (T13) for a raw `collection("<known
  name>")` outside the accessor module.
- A `field<T>()(path)` helper for dotted query paths (`"usage.inputTokens"`). This is where the
  `cost.total` class of bug lives.
- Contract test `schema.consumers`: fixtures built by the real writers, read by every consumer.
  Extend the seed already in `transcript-queries.unit`.
- The cockpit's `llm-call-types.ts` and related types re-export from the stored types instead
  of restating them.
- **Done when:** no `db.collection("…")` string outside the accessor module; T13 at 0; the
  CLAUDE.md collection list is generated from `stored/` (or checked against it by a test).

### 2. The agent loop core — rest of R-2, and #60 (≈2 d)

- `runAgent` (449 lines): add an explicit `TurnState` object (mental map, turn number, call
  sequence, loop messages, abort flag), threaded through the remaining phases. The five phases
  already in `agent-runner-phases.ts` are the pattern. Target under 120 lines; take
  `agent-runner.ts` off the oversize list.
- `runOrchestrationLoop` (419 lines, #60): split into named steps (wake-up wait, dispatch
  selection, error cooldown, budget pause, shutdown) over a `LoopState`. The orchestrator unit
  suite (TC-9, the #55 cooldown tests) is the safety net; add characterization tests first for any
  step it doesn't cover.
- **Done when:** both functions are under 120 lines, both files are off the structure allowlist,
  `orchestrator.ts` is off the complexity exemptions, and the integration suite is green.

### 3. Clear the small debt to zero (≈0.5 d)

- T8: the 7 empty catches each log operation, input and consequence, or carry a one-line reason
  why ignoring is safe. Allowance → 0.
- T9: each of the 20 casts is removed, or gets a `biome-ignore` / comment stating its
  constraint, then becomes a regex entry. Allowance → 0.
- The 7 bare `console.error(e)` get structured context. Add a tripwire for the pattern.
- One `DEFAULT_MODEL` (and `DEFAULT_VISION_MODEL`) in `agent-config`, used by the 6 files;
  tripwire on the literal outside it and `models.ts`'s price table.
- T11 comment history is **not** bulk-rewritten (decided in the audit plan); it shrinks as files
  are touched in steps 1–5.

### 4. Copilot tool files — #34, #36 (≈1.5 d)

- `mission-copilot-tools.ts` (`createMissionCopilotTools`, 1008 lines): one module per tool
  family (read, config, lifecycle, schedule — already split out, limits/resources, GitHub
  proxy), composed by a short factory. The precedent is `tools/` (one file per tool) and
  `mission-copilot-schedule-tools.ts`.
- Control-plane `copilot-tools.ts` (776-line factory) gets the same treatment; `copilot-router.ts`
  follows if it is still oversize afterwards.
- **Done when:** no factory is over 120 lines and the four files are off both allowlists.

### 5. Cockpit — #73 (≈2 d)

- Shared hooks for what every panel re-implements: `useApi` (fetch + `request()` errors +
  `useLoadError`), `useVisiblePoll`, and a panel shell with load and error states.
- Split `data.ts` (1023 lines) into one API module per domain (missions, transcripts, limits,
  files, copilot). Split `TracePanel` (545-line component) and `App.tsx` (router vs. views).
- The cockpit gets coverage floors at today's level, plus tests for the panels that write
  (Limits, Config, DraftEditor, Files) through their pure helpers. This continues the pattern of
  `limits-ceiling-text.unit` and `draft-validation.unit`.
- **Done when:** `data.ts`, `TracePanel.tsx` and `App.tsx` are off the structure allowlist and
  the cockpit has floors in `vitest.config.ts`.

### 6. Coverage that follows risk — #44 (ongoing, alongside 1–5)

- Per-file floors for the security and spend modules (`safe-path`, `ssrf`, `safe-http`,
  `spend-policy`, `mission-limits`, `limits`, `job-runner`, `schedule-ingest`, `auth*`) at 90%
  statements. Most are close already; this keeps them there.
- Package floors rise as each step lands, by whatever the step's tests added (never lowered).
  Target by the end of the plan: worker ≥ 60, control plane ≥ 55 statements.

### Later (issues, not scheduled here)

- `document-processor.ts` split by format (the audit's R-6), together with moving PDF extraction
  off the daemon thread (#79).
- `resource-upgrade.ts` / `resource-report.ts` split by phase (#59).
- `monitor-server.ts` DTO validation (#43). Most of it lands with step 1's typed documents;
  close or re-scope the issue afterwards.
- Rest of the shared domain package (#74), Express 5 + firebase majors (#68), data-factory Python
  dedupe and `pip-audit` (#69).
- Each remaining oversize file is taken when a feature next touches it: it is extracted before
  the feature is added.

## Order and effort

| # | Step | Effort | Depends on |
|---|---|---|---|
| 0 | Ratchets to today | 1 h | — |
| 1 | Typed stored documents | 1.5 d | — |
| 2 | Agent loop core | 2 d | 1 (TurnState uses the stored types) |
| 3 | Small debt to zero | 0.5 d | 1 (`DEFAULT_MODEL` lives beside the stored types) |
| 4 | Copilot tool files | 1.5 d | — |
| 5 | Cockpit | 2 d | 1 (API modules use the stored types) |
| 6 | Risk-weighted coverage | with each step | — |

About 8 working days. Steps 4 and 5 are independent of each other and of step 2.

## Exit criteria

- Structure allowlist ≤ 30 files (from 39); no allowlisted function over 300 lines.
- Complexity exemptions ≤ 24 (from 32).
- T8 and T9 at 0, T13 at 0, new tripwires for bare `console.error(e)` and the model literal.
- `schema.consumers` contract test covers every collection with more than one reader.
- Coverage floors raised as in step 6, cockpit floors exist.
- `docs/code-structure.md` updated; issues #34, #36, #43 (or re-scoped), #44, #60 and #73 closed;
  #84's R-2 and R-15 items ticked.

## Progress log

- 2026-10-19 — plan agreed.
