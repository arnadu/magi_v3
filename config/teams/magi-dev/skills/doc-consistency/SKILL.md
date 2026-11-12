---
name: doc-consistency
description: Keep the repository's documentation consistent with its code — inventory every claim in what you check (behaviour first), verify each against the code with evidence, find contradictions and features that no longer exist, and propose exact, ready-to-apply edits.
---

# Documentation consistency

You keep the documentation true. Developers, coding assistants and agents act on these
documents: a wrong statement about **behaviour** ("X does Y", "this feature exists", "this runs
when") sends them down the wrong path, and costs more than a missing table row. You **propose**
edits; you don't apply them.

## What is documentation here

In your clone: `MAGI_V3_SPEC.md`, `USER_GUIDE.md`, `README.md`, `MAGI_V3_ROADMAP.md`, everything
under `docs/`, and the `CLAUDE.md` files. Some of these are also **instructions** to agents or to
the coding assistant: the `CLAUDE.md` files, skills (`SKILL.md` under `packages/skills/` and
`config/teams/*/skills/`), prompts (`packages/agent-runtime-worker/prompts/`) and the team
templates' system prompts. Check them too, but report them in their own section. Don't propose
rewriting an accepted ADR; propose a status note or a new ADR.

## The method: inventory, then verify

Shallow checking finds wrong names and misses wrong behaviour. So, for whatever you check (a
section in a sweep, or the passages a commit touches):

1. **Inventory every claim** into a working file
   (`$WORKDIR/notes/claims-<doc>-<section>.md`), one line each, before checking any. Claims come
   in kinds; list all of them:
   - **behaviour**: what a component does, when, under which condition, with what effect;
   - **existence**: a feature, button, route, command, file, tool or setting is said to exist;
   - **values**: defaults, limits, thresholds, counts, versions;
   - **names**: commands, paths, tool and parameter names, environment variables;
   - **status**: open, fixed, done, planned, deprecated.
2. **Verify each, behaviour and existence first**, with evidence:
   - behaviour: find and read the code path that would make it true (the function, its callers,
     the condition); a name that exists proves nothing about what it does;
   - existence: search the current tree; if absent, `git -C <clone> log -S'<name>' --oneline`
     shows when it was added and removed — a removed feature still described is a finding;
   - values: find the constant or the default and its unit;
   - status: read the code the status refers to.
   Mark each line confirmed (with `file:line`), wrong (with `file:line`), or unverifiable (say
   why).
3. **Look for contradictions**: between two passages of the same document, and between documents
   (the spec versus the user guide versus a `CLAUDE.md`). One of the two is wrong; find which.
4. **Report coverage**, always: "N claims inventoried: X confirmed, Y wrong, Z unverifiable".
   "Found accurate" is allowed only with that count; a spot check must say it was one, and how
   many claims it covered.

Depth over breadth: one section verified fully is worth more than a document skimmed. A section a
turn is a good pace for sweeps; note where you stopped in your mental map.

## Two modes

**After commits** (scheduled): `repo-workspace` with `--lens docs`. For each commit, apply the
method to:
- the documents that describe the code it changed (search the docs for the changed files,
  functions, tools, routes, environment variables, commands); the working rules say which
  documents must change with which code (environment variables → `docs/env.md`, new failure
  modes → `docs/operational-resilience.md`, structure → `docs/code-structure.md`, agent tools →
  the spec, ...);
- the passages of any document it changed, in full, including the unchanged sentences around the
  edit. A commit that edited a document does not make the rest of that document correct.

**Sweep** (weekly, one area at a time; keep the rotation in your mental map): one section or
family, the method applied to every claim in it.

## Report

`$SHARED_DIR/reports/docs/YYYY-MM-DD-<mode>.md`:
- scope and **coverage** (the counts above, per section);
- one entry per inconsistency, id `DC-NNN` (sequential; last id in your mental map): the kind of
  claim, the document and line, what it says, what the code does (`file:line`), and the **exact
  edit** ("replace this / with this", or a unified diff);
- contradictions in their own section; instructions (skills, prompts, `CLAUDE.md`) in their own
  section;
- a **hand-off block**: "Apply the edits DC-012..DC-019 below to the documents; don't change
  code."

`working-agreements` applies: in particular, every fact in your proposed replacement text is
verified like any claim you review.

Move your cursor past the commits checked, update your mental map and KPIs. The weekly sweep's
report ends with a short PostMessage to the user.
