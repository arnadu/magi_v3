# ADR-0030 — `daemon.ts`: a widening `BootContext` threaded by value, not a class

**Status**: Accepted
**Sprint**: 28c (issue #33)
**Date**: 2026-09-15

---

## Context

The same 2026-08-09 audit that flagged `monitor-server.ts` (ADR-0029) also flagged `daemon.ts`'s
`main()`: ~792 lines doing the entire process bootstrap in sequence — env parsing, Mongo/repo
construction, workspace provisioning, signal handling, monitor/tool-server startup, job-runner
startup, mailbox watching, orchestration launch — with roughly 34 closure-captured local variables
threaded through by hand across genuinely sequential phases with real ordering dependencies (not
independent branches, unlike `handleRequest`'s routes — this made it the harder, riskier half of
the two files, done second once the extraction mechanics were proven on the easier one).

Two shapes were considered for how an extracted phase should receive its inputs and hand back its
outputs:

1. **A `Daemon` class** — each phase becomes a method, fields become instance properties assigned
   as each phase runs. Familiar OOP shape, but it relocates the god-object problem one level up:
   the class would need to declare all ~34 eventually-populated fields up front, most typed
   `T | undefined` (or forced non-null with `!`) until their producing phase actually runs partway
   through the constructor/an init method — exactly the kind of unsound optionality CLAUDE.md's
   Code Quality section asks to avoid ("reach for `any` or `!` only when genuinely unavoidable").
2. **Fully independent parameter lists per phase** — each extracted function declares only the
   exact locals it needs, no shared context object at all. Clean in isolation, but breaks down for
   the later phases: phase 20's callback construction alone reads from more than ten same-typed
   prior locals (`db`, `missionId`, `mailboxRepo`, `anomalyRecorder`, `monitor`, ...), and a
   fully-positional or fully-destructured parameter list of that size is worse to read and worse
   to keep in sync than a single named object.
3. **A single `BootContext` type, progressively widened, threaded by value** — each phase is typed
   `(ctx: Pick<BootContext, "a" | "b">) => Pick<BootContext, "c" | "d">`, and `main()` merges the
   return into a running `ctx` object via `Object.assign` after each call.

---

## Decision

**Option 3.** One interface, `BootContext` (`daemon-boot/context.ts`), grows one field group per
phase as phases are extracted — not designed all at once up front, since several fields' shapes
depend on decisions made while extracting earlier phases. Each phase function's `Pick<BootContext,
...>` input and output types are, by construction, an exact, enforced list of what that phase
reads and produces — no need to trust a doc comment or re-read the function body to know its real
dependency surface, and no way for a phase to reach for a field it didn't declare needing.

`main()` itself keeps a single `const ctx: Partial<BootContext> = { ... }` growing via
`Object.assign(ctx, phaseResult)` after each call, but — deliberately — **does not migrate the
rest of `main()`'s body to read from `ctx.x` everywhere**. Immediately after each
`Object.assign`, the same values are also bound to local `const`s (`const { mailboxRepo, ... } =
repos;`) exactly as before, and all of `main()`'s still-inline code keeps using those locals
unchanged. This means two things are simultaneously true for a while, by design: `ctx` accumulates
correctly (proving each phase's extraction and giving later phases a typed source they *could*
consume), while the untouched remainder of `main()` never needs invasive touch-every-line changes
just to switch from `x` to `ctx.x`. `Partial<BootContext>` rather than `BootContext` reflects
this honestly — during the transition, not every field's producing phase has been pulled out yet,
so the type shouldn't claim more than main() actually guarantees at that point.

Three of `daemon.ts`'s pre-existing error-handling patterns were preserved exactly, not
papered over, per the extraction methodology:

1. Phases that do `process.exitCode = 1; return;` (unwinding `main()` itself) return a
   discriminated `{ ok: true, ... } | { ok: false, exitMessage: string }` instead — a callee can't
   hide a `return` that has to unwind `main()`'s own scope, so the literal guard stays inline in
   `main()`, just fed by the phase's result (`parseDaemonEnv`, `loadDaemonTeamConfig`).
2. Phases that call a bare `process.exit(1)` or `process.exit(0)` (PID conflict, invalid
   `MAX_COST_USD`/port) keep that call verbatim inside the extracted function — these terminate
   immediately in production and never need to unwind through `main()`'s scope. (A test that mocks
   `process.exit` as a no-op rather than a throw has to account for any enclosing `try/catch` the
   original code already had — see `lockPidFile`'s test, where mocking the exit as a throw would
   otherwise be swallowed by the source's own `try/catch` around `process.kill`, a test-only
   ambiguity that can't arise in production since a real `process.exit` never returns.)
3. The outer `main().catch(...)` and the one `try { await runOrchestrationLoop(...) } finally
   {...}` around the whole mission run stay exactly as-is, entirely inline in `main()` — this is
   `main()`'s own process-lifecycle ownership, not a boot phase, and an extra indirection layer
   here would buy nothing while risking the exact re-throw/exit-code behavior it currently has.

One deliberate exception to "one phase, one commit": mission-copilot injection, OS-user
provisioning, and the copilot's source-access ACL grant were bundled into a single
`provisionAgentIdentities()` extraction, since this trio is the file's clearest load-bearing
sequential-ordering example (copilot injection must precede OS-user creation; the ACL grant must
run after it, since it needs the copilot's freshly-created OS user to exist) — splitting it across
three separate commits risked a later one silently reordering the sequence.

Functions with no boot-time role of their own — `runPendingJobs`, `startJobRunner`,
`logMemoryUsage`, `dataKeysEnv`, `cancelBackgroundJob` (already exported, used by nothing outside
`daemon.ts`) — stay in `daemon.ts` rather than moving into `daemon-boot/`, since they're ongoing
runtime concerns for the life of the process, not part of the sequential startup this ADR is
about. `ensureAgentUsers`/`grantMissionCopilotSourceAccess`, by contrast, *did* move physically
into `daemon-boot/agent-identity.ts`, since nothing outside `daemon.ts` imported them and leaving
them behind would have meant a circular import back into `daemon.ts` for no benefit.

---

## Consequences

- `main()` goes from ~792 lines to ~213: a widening `BootContext`, 19 named phase calls in
  sequence, then the orchestration-loop launch and its `finally` cleanup, unchanged.
- 19 new files under `agent-runtime-worker/src/daemon-boot/`, each unit-tested — mocking real I/O
  (`node:child_process`, `node:fs`, `connectMongo`, `loadTeamConfig`, `recoverOrphanedJobs`) where
  a phase would otherwise need a live Mongo/OS dependency just to construct its test fixture.
- `daemon-job.integration.test.ts` (a real daemon, real Mongo, real LLM calls, real background-job
  execution) was re-run after every risk-bearing extraction — OS-user provisioning, monitor/tool
  server startup, job-runner start, and both orchestration-callback commits — rather than after
  every single phase, matching the plan's own judgment that the earliest, purely-computational
  phases (log tee, repository construction, model/pricing resolution) don't meaningfully
  discriminate on that test.
- Live-verified beyond the test suite: pushed to dev, and a real mission provisioned on a fresh
  Fly machine confirmed the mailbox Change Stream wake-up, the full agent turn loop, spend-cap
  telemetry, and the decomposed `monitor-server.ts` routes all still work together end to end.
- No new trust boundary, external service, or `sudo` rule — every extracted phase's behavior is
  unchanged from the pre-decomposition code; `docs/security/threat-model.md` needed only a
  file-location correction for `ensureAgentUsers` (moved to `daemon-boot/agent-identity.ts`), not
  a new entry.
- CR-05 (auth token handling), the one remaining item from the original audit response, is now
  explicitly scoped against this decomposed structure rather than the god-function it replaces.

---

## Related

- `packages/agent-runtime-worker/src/daemon.ts` — `main()`, the remaining process-lifecycle triad
- `packages/agent-runtime-worker/src/daemon-boot/` — `context.ts` (the `BootContext` type) + all
  19 phase files
- `packages/agent-runtime-worker/tests/daemon-boot-phases.unit.test.ts`,
  `daemon-agent-identity.unit.test.ts` — one describe block per phase, grown in the same commit as
  that phase's extraction
- `packages/agent-runtime-worker/tests/daemon-job.integration.test.ts` — the real end-to-end
  regression backstop, re-run after every risk-bearing phase
- `docs/code-structure.md` — the file's inventory row, decomposition status
- `docs/code-review-audit-report-2026-08-09.md` / `docs/code-review-audit-response-2026-08-12.md`
  — the audit that flagged this file
- GitHub issue #33 (closed)
- ADR-0029 — the twinned decomposition of `monitor-server.ts`'s `handleRequest`, same sprint
