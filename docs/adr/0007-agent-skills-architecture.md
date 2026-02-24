# ADR-0007: Agent Skills Architecture

## Status
Accepted

## Context

Agents need reusable, domain-specific capabilities beyond what the base tool set provides.
The recurring problem: how do we give agents reliable procedural knowledge (git commit
conventions, inter-agent message formats, domain-specific workflows) without hardcoding
use-case assumptions into the tool API layer?

Three approaches were evaluated:

1. **Use-case-specific tools** — e.g., `PublishArtifact(label, artifact_type, files, derived_from)`.
   Reliable but prescriptive: the `artifact_type` enum (`raw_data | analysis | report | chart`)
   embeds equity-research vocabulary into the platform schema. Every new use case fights the schema
   or inflates it.

2. **Prompt-only SOPs** — inject step-by-step procedures into the system prompt.
   Flexible but unreliable: instructions degrade in long contexts; the LLM may skip steps without
   signalling failure.

3. **Filesystem-based skill packages** — instructions + executable scripts bundled as directories,
   loaded on demand. The LLM decides *when* to use a skill; scripts handle *how* deterministically.
   Anthropic's Agent Skills (2025) establish this as a format, fast becoming a de facto standard
   (analogous to MCP for tool integration). Format is LLM-agnostic: just YAML + Markdown + Bash.

## Decision

Adopt the **Anthropic Agent Skills format** as MAGI V3's extensibility mechanism, with a
four-tier scope hierarchy layered on top.

### Skill format (compatible with Anthropic's standard)

```
skill-name/
├── SKILL.md          ← required: YAML frontmatter + Markdown instructions
├── scripts/          ← optional: executable scripts run via Bash
├── references/       ← optional: loaded by the agent as needed
└── assets/           ← optional: templates, schemas, examples
```

**`SKILL.md` frontmatter:**
```yaml
---
name: git-provenance           # lowercase, hyphens only, max 64 chars
description: |
  Record completed work with a git commit and ledger entry.
  Use when finishing a research output, analysis, or report intended for the team.
---
```

The `description` is the trigger: the agent reads it at startup and decides when the skill
is relevant. The body is loaded only when triggered (via `cat` through the Bash tool).
Scripts are executed via Bash; their code never enters the context window — only their
output does. This is the key reliability property: deterministic operations are code, not
instructions.

### Four-tier scope hierarchy

```
Tier 1 (lowest)  Platform   packages/skills/                    read-only (ACL)
Tier 2           Team       config/teams/{team}/skills/         read-only (ACL)
Tier 3           Mission    /missions/{id}/shared/skills/       writable by all team agents
Tier 4 (highest) Agent      /home/agents/{id}/skills/           writable by that agent only
```

**Scope resolution:** same-name skills at a higher tier silently shadow lower tiers. An agent
that writes a `git-provenance` skill in its home directory overrides the platform version for
itself only. A mission-level skill overrides team and platform versions for all agents on that
mission.

**Shadowing, not overwriting:** platform and team skill directories are `r-x` for all agent
uid/gids (enforced by `setfacl` in Sprint 4). Agents cannot modify them. To change behaviour
they write a same-name skill at a higher scope. The system prompt block shows the active scope
tag so shadowing is visible.

### Skill discovery at agent startup

`discoverSkills(agentId, missionId, teamSkillsPath)`:
1. Scan all four tier directories in order (platform first, agent-local last)
2. Extract YAML frontmatter from each `SKILL.md`
3. Build a `Map<name, SkillMetadata>` — later tiers overwrite earlier for same name
4. Inject a compact block into the system prompt (~100 tokens regardless of skill count):

```
## Available Skills
Read SKILL.md and run scripts/ via Bash when relevant.

- git-provenance [platform]: Record completed work with git commit and ledger entry. Use when finishing an output for the team.
- inter-agent-comms [platform]: PostMessage conventions. Use when drafting a message to a peer agent.
- sec-filing-parser [team]: Parse 10-K/10-Q/8-K documents. Use when working with SEC filings.
- aapl-pivot-analysis [mission, shadows team]: AAPL-specific pivot written by data-scientist-1.
```

No new tool is needed: agents read skill files and run scripts using the existing `Bash` tool.

### Mission workspace as git repository

`workspace-manager` runs `git init` on the shared mission folder at mission startup. The
`git-provenance` skill teaches agents to commit their outputs. The commit log is the lineage
audit trail: `git log --follow`, `git show`, and `git diff` give the Evidence Explorer
everything it needs. No custom MongoDB artifact registry required.

### Platform default skills (three ship with MAGI V3)

| Skill | Description |
|-------|-------------|
| `skill-creator` | Teaches agents to write new skills. Adapted from Anthropic's reference implementation. Ships with `scripts/init_skill.sh` (scaffolds directory) and `references/design-patterns.md`. |
| `git-provenance` | Git-based data lineage: commit convention, `ledger.jsonl` format, sources recording. Ships with `scripts/record-work.sh`. |
| `inter-agent-comms` | `PostMessage` conventions: intent types, `artifact_refs` format, subject line structure, priority levels. Pure instructions, no scripts. |

### Agent-authored skills

Agents can write new skills to the mission or agent-local tier using the `skill-creator`
platform skill. Skills written during a mission accumulate in the shared folder and are visible
to all agents on subsequent turns of the same mission. A human (or lead agent) can promote a
mission skill to the team config via a normal git PR.

Whether agents should be permitted to shadow team or platform skills is an empirical question
resolved in Sprint 9's evaluation harness (run with and without agent-local shadowing enabled;
observe whether skills improve or destabilise mission outcomes).

## Tool vs. skill decision criterion

The deciding factor is **token cost per LLM call**, not the local/non-local nature of the effect.

A registered tool schema (name, description, input_schema) is injected into every API call,
whether the agent uses it that turn or not. A skill costs ~100 tokens at startup (metadata
block) and the SKILL.md body only in the turn where the agent reads it. Script execution
costs zero tokens — only the script's output enters the context.

A skill script can have non-local effects: it can POST to the HTTP API, write to MongoDB,
or call any external service. Execution privileges are the agent's Linux uid/gid, not a
special elevated context.

Decision rule:

| Capability | Frequency | Form |
|---|---|---|
| Used most turns (Bash, WriteFile, PostMessage, UpdateMentalMap) | High | Tool |
| Used frequently, most missions (FetchUrl, SearchWeb, InspectImage) | Medium | Tool |
| Used occasionally — once or twice per cycle (scheduling, background execution) | Low | Skill |
| Domain conventions, lineage, inter-agent etiquette | Rare | Skill |

`ScheduleMessage`/`CancelSchedule` and `RunBackground` were originally designed as tools.
They are re-classified as skills (`schedule-task`, `run-background`) because:
- An agent makes O(50) LLM calls per mission but schedules O(1–2) times
- Keeping unused tool schemas in every call wastes ~400 tokens × 50 calls = 20,000 tokens
- The scripts POST to the HTTP API — the non-local effect is preserved; only the registration
  mechanism changes from a TypeScript handler to a curl call in a Bash script

## Consequences

- `PublishArtifact` tool is dropped — replaced by the `git-provenance` platform skill.
- `ListArtifacts` tool is dropped — agents query via `git log --oneline` or
  `cat ledger.jsonl | jq ...` via Bash.
- `discoverSkills()` is added to `buildSystemPrompt()` in `agent-runtime-worker`.
- `workspace-manager` (Sprint 4) initialises the shared mission folder as a git repo.
- Three platform default skills land in `packages/skills/` in Sprint 6.
- The skill format is format-compatible with Anthropic's Agent Skills standard, enabling
  portability: skills authored for MAGI V3 can be uploaded to Claude.ai or the Anthropic API
  with no changes.
- Skills are auditable: every skill is a directory of plain text files, tracked in git,
  reviewable before deployment — no opaque binary registrations.
