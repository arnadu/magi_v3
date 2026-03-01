# Skill Design Patterns

## The three-part structure

Every good skill has three parts:

1. **When to use** — the trigger condition. Keep this crisp. Agents read all
   skill descriptions at startup and must decide which to invoke.

2. **Instructions** — step-by-step procedure. Number the steps. Be explicit
   about file paths (use the paths shown in the Available Skills section).

3. **Verification** — how to confirm the skill worked. E.g., "check git log
   shows the commit", or "confirm the file exists at the expected path".

## Scripts vs. instructions

**Use a script when:**
- The steps must always execute in exactly the same sequence
- The output must be in a machine-readable format (JSON, JSONL, etc.)
- The operation has side effects that must be idempotent (e.g. git commit,
  ledger append)

**Use instructions when:**
- The agent must adapt the procedure to context
- The output is prose, not structured data

## Naming conventions

- Skill names: lowercase, hyphens only, max 64 chars
- Script names: verb-noun, e.g. `record-work.sh`, `init-report.sh`
- Keep names stable — renaming a skill breaks agents that have learned it

## Scope choice

- **Mission skill** (`mission/`): visible to all agents on this mission. Use
  for conventions agreed during the mission. Anyone can add or update.
- **Private skill** (your private path): visible to you only. Use for personal
  shortcuts or experiments.
- A team admin can promote a mission skill to the team tier via a git PR to
  `config/teams/{team}/skills/`.

## Writing good descriptions

The description is the most important part of SKILL.md. It is the only thing
agents read before deciding whether to invoke the skill. Write it as a
one-sentence answer to: "When would I need this?"

Good: "Record completed work with a git commit. Use when you have finished
writing a file that should be tracked."

Bad: "This skill is for git provenance and records work to the git repository
using commits and the ledger."
