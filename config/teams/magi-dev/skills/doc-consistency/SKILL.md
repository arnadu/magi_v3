---
name: doc-consistency
description: Keep the repository's documentation consistent with its code — after each batch of commits and in periodic sweeps, find statements the code now contradicts, and propose exact, ready-to-apply edits.
---

# Documentation consistency

You keep the documentation true. A document that misleads a reader (a developer, a coding
assistant, an agent) is a defect, just as a bug is. You **propose** edits; you don't apply them:
your reports contain ready-to-apply changes the user hands to the developers' coding assistant.

## What is documentation here

In your clone: `MAGI_V3_SPEC.md`, `USER_GUIDE.md`, `README.md`, `MAGI_V3_ROADMAP.md`, everything
under `docs/` (deployment, environment variables, operational resilience, code structure, plans,
ADRs, security documents), and the `CLAUDE.md` files.

Some of these are also **instructions** to agents or to the coding assistant: the `CLAUDE.md`
files, skills (`SKILL.md` under `packages/skills/` and `config/teams/*/skills/`), prompts
(`packages/agent-runtime-worker/prompts/`) and the team templates' system prompts. Check them
for consistency too (a skill naming a tool, path or file that doesn't exist misleads every agent
that reads it), but flag them separately in the report: changes to instructions get extra care.

ADRs record a decision at a point in time: don't propose rewriting an accepted ADR; propose a
status note or a new ADR instead.

## Two modes

**After commits** (scheduled): `repo-workspace` with `--lens docs`. For each commit:
- code changed → which documents describe that code? (search the docs for the file, function,
  tool, route, environment variable or command names.) Do they still hold?
- a document changed → is what it now says true of the code?
The working rules say which documents must change with which code (environment variables →
`docs/env.md`, new failure modes → `docs/operational-resilience.md`, structure →
`docs/code-structure.md`, agent capabilities and tools → the spec, ...); check those first.

**Sweep** (weekly, one area at a time; keep the rotation in your mental map): take one document
or one family (the user guide; the spec's tool chapter; the security documents; the copilot
skills; ...) and check every concrete claim in it against the code: commands, file paths,
tool names and parameters, defaults, environment variables, collection names, statuses
("open", "done", "planned").

## How to check a claim

A concrete claim is checkable: find the code that decides it and compare. Examples:
- "a new mission starts with a $N cap" → find where missions are created and the constant;
- "tool X takes parameter Y" → find the tool's definition and its schema;
- "this mitigation is in place" or "this item is open" → read the code the statement names.
When the code contradicts the document, it is a finding. When the document describes something
you can't find at all, search once more under other names, then report it as "not found".

## Report

`$SHARED_DIR/reports/docs/YYYY-MM-DD-<mode>.md`:
- scope (commit range, or the document swept);
- one entry per inconsistency, id `DC-NNN` (sequential; keep the last id in your mental map):
  the document and line, what it says, what the code does (file:line), and the **exact edit**
  as a unified diff or a "replace this / with this" pair;
- instructions (skills, prompts, `CLAUDE.md`) in their own section;
- a **hand-off block**: "Apply the edits DC-012..DC-019 below to the documents; don't change
  code." for the developers' coding assistant.

Move your cursor past the commits reviewed, update your mental map and KPIs. Don't message the
user for each report; the weekly sweep's report ends with a short PostMessage.
