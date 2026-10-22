# Sprint closure checklist — working practice

Moved out of the root `CLAUDE.md`, which keeps the one-line triggers; this is the full text.

Sprint close is a **confirmation pass** — this work should already be done. If a check fails here, that is a process gap to address going forward, not just a box to check now.

1. **Lint and tests pass** — `npm run lint && npm test`
2. **Security review confirmed** — `/security-review` was run for any new external surface during the sprint; CRITICAL/HIGH findings are fixed; others are logged in `docs/security/findings.md`
3. **Threat model current** — any new external HTTP call, `sudo` rule, process user, or IPC port was documented in `docs/security/threat-model.md` in the same commit as the code
4. **Operational resilience current** — run `/operational-resilience`; any new component's failure modes are documented in `docs/operational-resilience.md`; any closed gaps are removed from the gap table
5. **Code structure current** — run `/code-structure-review`; new files/functions crossing the thresholds in the Code Structure section are logged in `docs/code-structure.md`
6. **ADRs written** — any decision between concrete alternatives has an ADR in `docs/adr/`; superseded ADRs are marked
7. **Sprint status** — mark the sprint `✅ Done` in `MAGI_V3_ROADMAP.md` with a one-line summary, and update the root `CLAUDE.md` Sprint Roadmap section

Use `/sprint-close` to run checks 1–2 automatically.
