# skills

Platform skills: every directory here with a `SKILL.md` is copied into every mission's
`shared/skills/_platform/`, read-only to agents. Not an npm workspace — there is no
`package.json`; scripts run as the agent's OS user inside the mission. Loaded on top of the root
`CLAUDE.md` when working here.

- `SKILL.md` frontmatter: `name` and `description` (the first line of the description is what
  agents see in their skills block). A skill's scope comes from its directory, not frontmatter.
- Scripts must work with only `PATH` and `HOME` in the environment, plus `MAGI_TOOL_URL`/
  `MAGI_TOOL_TOKEN` when run as a background job; no secret is ever available to them (data
  providers are reached through the `data-*` Tool API proxies).
- Text an agent reads is checked by contract tests: every `skills/_platform/<skill>/scripts/<file>`
  path a skill, template or prompt mentions must exist
  (`packages/agent-runtime-worker/tests/llm-text-references.unit.test.ts`). Wording itself is
  judged by reading, not tested.
- The cockpit's skill toggles list this directory through `GET /api/catalog`.
