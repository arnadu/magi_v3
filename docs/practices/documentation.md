# Documentation — working practice

Moved out of the root `CLAUDE.md`, which keeps the one-line triggers; this is the full text.

Documentation updates go in the **same commit as the code change**. Documentation written a week later is written from memory.

**What belongs where:**

| What changed | Where to document |
|---|---|
| New architectural decision (technology, schema, design pattern) | New ADR in `docs/adr/`; link from sprint table |
| New trust boundary, external service, `sudo` rule, or IPC port | `docs/security/threat-model.md` |
| New component with failure modes, new external dependency, new scheduled action | `docs/operational-resilience.md` |
| New or changed env var | `packages/agent-config/src/env-catalog.ts`, then `npm run docs:env` (and an operational note in the package `CLAUDE.md` if it changes behaviour) |
| New CLI flag or build command | The package's `CLAUDE.md` (root `CLAUDE.md` only for repo-wide commands) |
| New cloud deployment step or Fly.io operational quirk | `docs/deployment.md` |
| New agent capability, tool, or inter-agent protocol | `MAGI_V3_SPEC.md` (relevant section) |
| Subtle code invariant that would surprise a reader | Inline comment in the source |
| Superseded design or technology | Mark the ADR `SUPERSEDED`; update whichever `CLAUDE.md` (root or package) describes it |
| New file/function crossing a Code Structure threshold, or a decomposition decision | `docs/code-structure.md` |

Aim for: **top-down architecture** (mental model before implementation detail), **subtleties surfaced** (non-obvious constraints and invariants), **operations covered** (install, run, debug, scale). A new person should understand _why_ first, then _what_, then _how_.
