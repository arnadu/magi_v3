# Code quality — working practice

Moved out of the root `CLAUDE.md`, which keeps the one-line triggers; this is the full text.

Quality is applied **continuously during development**, not recovered at sprint close. These are the standards to meet as code is written.

**Types model the domain.** Before implementing a function, get the types right. Where `string` could be more specific — a discriminated union, a named interface, a Zod-validated shape — use it. Reach for `any` or `!` only when genuinely unavoidable; document why with a `biome-ignore` comment. TypeScript strict mode is always on; work with it, not around it.

**Interfaces before implementation.** When adding a module, sketch the interface first. If the API is awkward to use, the abstraction is wrong — fix the design, not the callers.

**Logging survives incidents.** Every `console.error` must answer: what operation failed, what input triggered it, what the downstream consequence is. `console.error(e)` is a placeholder. Prefer structured context: `[daemon] orchestration failed { missionId, agentId, error: e.message }`.

**No deferred debt.** A type cast, a `TODO`, or a hardcoded value is a deliberate trade-off that must be visible. Either fix it in the same commit, or leave a comment explaining the constraint. Invisible debt is worse than acknowledged debt.

**No fallbacks to accommodate tests.** When a hard requirement lands, fix the test. Code that silently degrades — optional fields, `?? default` catch-alls added specifically to keep old tests green — is debt with compounding interest.

**Comments on the non-obvious only.** Well-named identifiers explain the what. Add a comment only for: a hidden constraint, a subtle invariant, a non-obvious workaround, behaviour that would surprise a reader. Never reference the current task or caller — those belong in commit messages.

**Lint after every change session.** Run `npm run lint` before committing. The pre-commit hook enforces this, but earlier is better. Use `npm run lint:fix` for auto-fixable issues, then fix remaining errors manually.
