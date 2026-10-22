# Testing approach — working practice

Moved out of the root `CLAUDE.md`, which keeps the one-line triggers; this is the full text.

Three tiers:

- **Unit tests** — pure, deterministic logic only (config validation, ACL policy, HTML patching). `npm test`, no LLM calls, no network.
- **Integration tests** — real LLM calls with deterministic-outcome prompts. Full stack including tool execution and persistence. `npm run test:integration` — requires `ANTHROPIC_API_KEY` and `MONGODB_URI`. Each test uses a unique `missionId`; `afterEach` cleans up with `deleteMany({ missionId })`.
- **Evaluation tests** (`eval/`, **planned — not yet implemented**, see [issue #45](https://github.com/arnadu/magi_v3/issues/45)) — golden scenarios for structural/policy outcomes, run on demand, not in CI. Until this exists, do not claim eval coverage for research quality, citations, agent collaboration, or operator workload.

Test runner: **vitest** — native ESM, no build step. Config: `vitest.config.ts` (unit), `vitest.integration.config.ts` (integration). Setup file: `vitest.setup.ts` loads `.env`.

Do not write tests for prompt wording, LLM tool selection choices, or report content quality — until the evaluation harness above exists, judge those manually.
