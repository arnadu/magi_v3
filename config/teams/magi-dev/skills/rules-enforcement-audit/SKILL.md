---
name: rules-enforcement-audit
description: For every written code rule in the repository (CLAUDE.md files, docs/practices), find what enforces it, measure compliance on a sample, and propose automatic enforcement for rules that are being broken. Rules nothing checks get ignored.
---

# Rules enforcement audit

The October 2026 audit concluded that guidelines nobody enforces tend to be ignored. This skill
keeps a living matrix of every rule, how it is enforced, and whether it is followed. Run monthly;
the first run builds the matrix, later runs update it.

## The matrix

`$SHARED_DIR/reports/code-review/rules-matrix.md`, one row per rule:

| Column | Content |
|---|---|
| Id | `R-NN`, stable across runs |
| Rule | One line, quoted or closely paraphrased |
| Source | File and section (`CLAUDE.md` "Working rules", `docs/practices/code-quality.md`, a package `CLAUDE.md`, ...) |
| Enforcement | `tool` (name the tool and where it is configured), `tripwire Tn`, `test` (name it), `review only`, or `none` |
| Compliance | For rules not fully enforced by a tool: what you sampled, how many violations; for tool-enforced rules: the allowlist size and whether each entry's reason still holds |
| Proposal | For a broken rule with weak enforcement: a concrete check (pattern, scope, current hit count) |
| Last checked | Date and commit |

## Procedure

1. **Collect the rules.** Read the root `CLAUDE.md` ("Working rules"), each package `CLAUDE.md`
   ("Conventions"), and `docs/practices/*.md`. A rule is a statement a change could be checked
   against ("every console.error says what failed, on what input, and the consequence"). Skip
   aspirations that can't be checked, but list them once under "not checkable" so the user sees
   them.
2. **Find the enforcement.** For each rule, search: `scripts/audit/tripwires.sh` (the T-numbers
   and their comments), `biome.json`, `scripts/audit/structure-check.mjs`, `vitest.config.ts`,
   `.github/workflows/quality.yml`, the `tests/` folders (contract and `llm-text-references`
   tests), `.githooks/`. Name the exact check, or write `review only` / `none`.
3. **Measure compliance where enforcement is partial.** Use `grep -rn` across `packages/*/src`
   with a pattern that approximates the rule. Count hits, read a sample of 5–10, and classify
   each as a violation, a justified exception, or a false hit. Record the pattern so the next
   run is comparable.
4. **Check allowlists.** For `tripwires.allow`, `structure.allow.json` and Biome's exemptions:
   does each entry's stated reason still hold in the current code? An entry whose reason has
   expired is a finding.
5. **Propose enforcement** for each rule that is broken and only review-enforced: the tripwire
   pattern (`grep -E` syntax, the paths it scans), or a lint rule, or a test; its current hit
   count; whether it needs an allowlist to start (a ratchet: today's count as the ceiling).
   Proposals that would create noise (many false hits) are worse than none: say so and propose
   a narrower rule.

## Output

The updated matrix, and a report `YYYY-MM-DD-rules-audit.md`: the rules whose compliance changed,
broken rules with their proposals, expired allowlist entries, and a hand-off block for the
developers' coding assistant ("Add tripwire T16 as follows: ...; fix the 3 current violations
first").
