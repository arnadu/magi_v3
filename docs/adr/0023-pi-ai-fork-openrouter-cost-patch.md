# ADR-0023 — pi-ai upgrade + local patch for OpenRouter's real cost, delivered via patch-package

**Status**: Accepted
**Sprint**: 26c
**Date**: 2026-07-29

---

## Context

Issue #10 tracks a known gap: MAGI_V3's cost tracking for OpenRouter-routed calls is always an
*estimate* (a static per-token price table baked into pi-ai), never the provider's own reported
cost. OpenRouter now always includes `usage.cost` (the provider's actual charged amount, in
credits) in every response — no request flag needed, the old `usage.include` option is deprecated.
pi-ai (the library MAGI_V3 depends on, pinned at `@mariozechner/pi-ai@0.52.12`, itself an alias for
the old `@mariozechner/pi-ai` npm scope) reads and discards this field, computing only its own
estimate.

Two paths were considered: (a) request the feature upstream and wait, or (b) fork, patch, and
test locally first, submitting the same patch as a PR once proven. (b) was chosen — waiting alone
has no forcing function, and a locally-validated patch is a strictly stronger PR than an
unvalidated one.

`badlogic/pi-mono` (the repo `@mariozechner/pi-ai` was published from) has since been renamed to
`earendil-works/pi`, and its npm publish target moved to `@earendil-works/pi-ai`. The old scope is
dead (frozen at `0.73.1`). A PR must target the live repo's current `main`, so the fork was cut
from `earendil-works/pi` at `main` (`b6fb91e`), not the old pinned version — a ~30-version jump
from what MAGI_V3 was running (`0.52.12` → `0.82.1`).

## Decision

### The patch

Two files, minimal:

- `packages/ai/src/types.ts` — `Usage` gains `providerCost?: number`, independent of `cost.total`
  (pi's own estimate).
- `packages/ai/src/api/openai-completions.ts` — `parseChunkUsage` reads `rawUsage.cost` (OpenRouter
  and any other OpenAI-completions-shaped provider that populates it) and sets `providerCost` when
  present. Both the streaming and non-streaming `usage` parse paths are covered by this one change.

### Full re-test before adoption, not just the patch

The version jump was tested independently of the patch's own correctness: pi's own test suite
(681/681 passing, 784 skipped — provider tests gated behind live credentials this environment
doesn't have) proved the fork itself was sound; MAGI_V3's full build/lint/unit(303)/integration(90)
suite — the last tier making real LLM calls against both Anthropic and OpenRouter — proved the
version bump didn't silently change MAGI_V3's own behavior.

One real breaking change surfaced from the jump, unrelated to the patch: pi's `v0.80.0` moved
`completeSimple`/`getModel` (and the rest of the old global API) out of the root entrypoint,
temporarily preserved at `@earendil-works/pi-ai/compat` (pi's own CHANGELOG: "will be removed in a
future release"). Rather than depend on a shim documented as temporary, MAGI_V3 migrated its 4
call sites (`loop.ts`, `models.ts`, `tools/inspect-image.ts`, `document-processor.ts`) to the new
`Models` API: a single shared collection (`piModels`, in `models.ts`) built from
`createModels()` + `anthropicProvider()` + `openrouterProvider()` — only the two providers MAGI_V3
actually calls, not the full built-in catalog — replacing the free `completeSimple`/`getModel`
functions with `piModels.completeSimple(...)` / `getBuiltinModel(...)`. Auth still resolves from
`ANTHROPIC_API_KEY`/`OPENROUTER_API_KEY` via the environment, unchanged behavior.

### Delivery: patch-package against the real published package, not a `file:` link to the fork

The local fork clone (`/home/remyh/ml/pi`, sibling directory, not part of this repo) was the
right tool for *testing* the jump — full source, full test suite, fast iteration. It is the wrong
tool for *shipping* it: both Dockerfiles' build context is the MAGI_V3 repo root only, and a
`file:../pi/packages/ai` dependency resolves to a path outside that context entirely — `npm ci`
would fail the moment it hit a real container build. The `main` branch also isn't the exact
`0.82.1` tag (a few commits ahead — confirmed by diffing the fork's built output against the
registry package's, where an unrelated `StopReason: "pending"` addition showed up as noise to
filter out of the real patch), so copying files wholesale from the fork was never safe.

Instead: `package.json` now depends on the real registry package, aliased so no import specifier
in MAGI_V3's own source has to change:

```json
"@mariozechner/pi-ai": "npm:@earendil-works/pi-ai@0.82.1"
```

`patch-package` (new devDependency) reapplies `patches/@mariozechner+pi-ai+0.82.1.patch` — generated
by hand-applying the same 2-line/6-line change directly to the installed package's compiled
`dist/` output (verified via `diff` against the fork's own build to confirm no unrelated drift
leaked in), then `npx patch-package @mariozechner/pi-ai`. Both Dockerfiles already run
`npm ci --ignore-scripts` (deliberate — skips arbitrary install scripts from the full dependency
tree as a supply-chain precaution), which also skips `patch-package`'s own `postinstall` hook; both
gained an explicit `COPY patches/` + `RUN npx patch-package` step immediately after `npm ci`.

This is a standard, narrow, revertable pattern: drop `patches/@mariozechner+pi-ai+0.82.1.patch` and
the two Dockerfile lines the moment the upstream PR merges and a release picks it up.

## Consequences

- **Deployable.** No `file:` link, no dependency on a sibling directory or GitHub reachability at
  build time — just the normal npm registry pull plus a small, auditable diff this repo owns.
- **No dependency on a temporary, soon-to-be-removed API surface.** The `/compat` migration was
  done now, while the jump was already being re-tested end to end, rather than deferred as
  invisible debt.
- **~30-version jump in a dependency every agent's LLM call runs through**, including OpenRouter
  auth resolution, streaming, and cost calculation for the live gold-digest-v2 mission (already
  moved to OpenRouter). Scoped deliberately to dev first (`magi-missions-dev`/`magi-control-dev`)
  before any production rollout — a version jump this size warrants running in the wild for a
  while before it touches a live mission's actual spend tracking.
- **Verification performed**: pi's own suite (681/681), MAGI_V3 build/lint/303 unit/90 integration
  — run twice, once against the local fork and again against the final published+patched
  dependency, to prove the delivery mechanism swap didn't change behavior.
- **Not yet done**: submitting the patch as a PR to `earendil-works/pi` (the original motivation for
  forking at all) — planned once this has run in dev for a while. `issue #10` stays open until
  MAGI_V3 is actually reading `providerCost` for real cost accounting (this ADR lands the
  *capability*; wiring `openrouter-pricing.ts`/cost attribution to prefer `providerCost` when
  present is separate, follow-up work).

## Related

- [GitHub issue #10](https://github.com/arnadu/magi_v3/issues/10) — OpenRouter real-cost tracking,
  stays open
- `packages/agent-runtime-worker/src/models.ts` — `piModels`, `getBuiltinModel` usage
- `packages/agent-runtime-worker/src/loop.ts` — default `completeFn`
- `patches/@mariozechner+pi-ai+0.82.1.patch` — the patch itself
- `packages/agent-runtime-worker/Dockerfile`, `packages/control-plane/Dockerfile` — the explicit
  `patch-package` step
