# Testing approach — working practice

Moved out of the root `CLAUDE.md`, which keeps the one-line triggers; this is the full text.

Three tiers:

- **Unit tests** — pure, deterministic logic only (config validation, ACL policy, HTML patching). `npm test`, no LLM calls, no network.
- **Integration tests** — real LLM calls with deterministic-outcome prompts. Full stack including tool execution and persistence. `npm run test:integration` — requires `ANTHROPIC_API_KEY` and `MONGODB_URI`. Each test uses a unique `missionId`; `afterEach` cleans up with `deleteMany({ missionId })`.
- **Evaluation tests** (`eval/`, **planned — not yet implemented**, see [issue #45](https://github.com/arnadu/magi_v3/issues/45)) — golden scenarios for structural/policy outcomes, run on demand, not in CI. Until this exists, do not claim eval coverage for research quality, citations, agent collaboration, or operator workload.

Test runner: **vitest** — native ESM, no build step. Config: `vitest.config.ts` (unit), `vitest.integration.config.ts` (integration). Setup file: `vitest.setup.ts` loads `.env`.

Do not write tests for prompt wording, LLM tool selection choices, or report content quality — until the evaluation harness above exists, judge those manually.

## Mocks and external contracts

A mock of one of our own functions encodes what we believe; it cannot show the belief is
wrong. On 2026-11-13 every test of the wake path mocked `machineExists` to return `true` or
`false`, and every one passed, while the function itself answered `true` for a machine Fly
reports as destroyed. Tests built on that belief kept a mission down for seven hours.

- **What a provider does is tested at the module that talks to it**, against the provider's
  actual answers (status codes and bodies captured from the live API, kept as fixtures):
  `fly-machines.unit.test.ts` for Fly, `image-client.unit.test.ts` for OpenRouter's images.
  A fact we have not seen the provider produce is an assumption; say so in the code.
- **One operation, one implementation.** When two entry points do the same thing (a route and a
  copilot action), they call one function, tested once; the entry points' tests check only the
  hand-off. Two implementations drift, and the tests of each pass.
- **Recovery paths are tested from the failure, not from the success.** For a lifecycle
  operation, write the test that starts from the broken state seen live (machine destroyed,
  server full, record drifted) and checks the mission comes back.

