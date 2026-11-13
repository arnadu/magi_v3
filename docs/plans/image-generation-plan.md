# Image generation — plan of action

Status: **agreed 2026-11-13; Phase 0 done, Phase 1 next.** Decision record:
[ADR-0035](../adr/0035-image-generation-sub-agent.md) (Accepted after appsec's review and the spike).
First use cases: the Houseplant Grand Hotel logo and website illustrations; figures for the
meteorology textbook. Interactive apps (#42) follow as a separate plan.

## Goal and done criteria

An agent asks for images with one `CreateImage` call (a brief); a sub-agent picks the model,
generates candidates, critiques and refines them within a budget, and returns file paths, a
contact sheet and a paragraph. Done when:

- the Houseplant Creative Director produces at least four logo candidates, two of them SVG, and
  a contact sheet the operator opens in the Files panel;
- every generation appears in `llmCallLog` and the turn statistics at a **non-zero** cost, and
  the mission cap stops image spend like any other;
- the test harness below is green, including the live check of each menu model.

## Phase 0 — Spike (half a day, before any production code)

Live calls against OpenRouter for each of the six menu models (about $1 in total), recorded in
the plan's progress log:

1. **Request shape** per model: does `image_config` (aspect ratio, size) apply; how many images
   per call; does a reference image work for editing; text rendering.
2. **Response shape**: PNG vs SVG (`data:image/svg+xml`), size in bytes, latency.
3. **Cost**: does each image response carry `usage.cost`, as chat responses do (which our
   pi-ai patch already surfaces as `providerCost` for chat)? If it does, extending the patch to
   `api/openrouter-images.js` is all that is needed. If not, fall back to
   `GET /api/v1/generation?id=<responseId>` for the charge.
4. **Critique model**: compare two vision models (e.g. a Gemini Flash and a Claude Sonnet) on
   critiquing four candidates against a brief; pick the default `imageAgentModel` on quality
   per dollar.
5. **SVG rasterization**: render a Recraft SVG to PNG with the existing headless Chromium,
   scripts and network off; measure time and memory.

Output: the request/response notes, the chosen cost path, the ceiling price per menu model, the
default critique model. Any surprise that changes ADR-0035 is written into it before Phase 1.

## Phase 1 — The generation client and metering (1 day)

| File | Content |
|---|---|
| `packages/agent-runtime-worker/src/images/image-models.ts` | The typed menu: id, kind (`vector`, `raster-art`, `raster-instruct`), tier (draft, final), output format, ceiling price per image; `resolveImageModel(kind, tier, missionRestriction)` |
| `patches/@mariozechner+pi-ai+0.82.1.patch` | Extended to `api/openrouter-images.js`: `parseUsage` surfaces OpenRouter's `usage.cost` as `usage.providerCost`, as the chat path already does (regenerate with `npx patch-package @mariozechner/pi-ai`) |
| `packages/agent-runtime-worker/src/images/image-client.ts` | One generation call over pi-ai's `generateImages`: prompt, reference images (contained paths, size-capped), aspect ratio (via `onPayload`); returns images (bytes, mime type), `providerCost` (or the ceiling estimate, flagged), response id; honours `AbortSignal` and a timeout |
| `packages/agent-runtime-worker/src/llm-meter.ts` | Accept an image call: record `providerCost` (or the flagged ceiling estimate) through the same path as other tool-side calls; never zero for a generation that returned an image |
| `packages/agent-config/src/loader.ts`, `env-catalog.ts` | `mission.imageAgentModel` (optional, known model) and `mission.imageModels` (optional restriction of the menu kinds); validated like `model`/`visionModel` |
| `packages/agent-runtime-worker/src/models.ts` | Image models are known only through the menu; `isKnownModelId` unchanged for chat models |

## Phase 2 — The sub-agent and the tool (1–1.5 days)

| File | Content |
|---|---|
| `src/images/create-image-tool.ts` | `CreateImage` tool: parameters (brief fields, `options` 1–6, `refineJob`/`refineCandidate`, `maxImages`, `maxUsd` up to platform caps), `maxRuntimeMs` 10 minutes, containment of reference paths (the agent's permitted roots, as Research's `context_files`) |
| `src/images/image-agent.ts` | The sub-agent loop (`runInnerLoop`, as Research): system prompt from `prompts/image-agent.md`; tools `generate_image`, `critique_candidates`, `finish`; budget enforced by the tools themselves (they refuse past `maxImages` / `maxUsd`), turn limit, abort |
| `src/images/image-job.ts` | Job folder `shared/images/<job-id>/` (unguessable id, exclusive creation, no link following), `manifest.json`, `contact-sheet.html` (images embedded), refine reads a previous job's manifest (same mission, the caller's own job or one in `shared/`) |
| `src/images/svg-raster.ts` | SVG → PNG for critique in an isolated headless page (scripts and network off), under the per-machine browser limit (#105) |
| `prompts/image-agent.md` | How to pick the kind and tier, prompting per family (descriptive for FLUX, instructional for Gemini, vector-specific for Recraft), the critique rubric, the reverse-prompt template, when to stop |
| `src/tools.ts` wiring, `disabledTools` | The tool is available to every agent unless disabled; the mission copilot can disable it per agent |
| `packages/skills/illustration/SKILL.md` | For calling agents: how to write a good brief, how to ask for a refinement, what the result contains |

## Phase 3 — Cockpit and copilots (half a day)

- Files panel: `shared/images/` jobs show their contact sheet; nothing else needed (images and
  sandboxed HTML previews already render). Check SVG preview behaviour (attachment + sandbox).
- Mission Config: `imageAgentModel` and the menu restriction, with prices shown.
- The copilots' `agent-design` skill: which agents should have `CreateImage`, how to budget it.

## Phase 4 — Documentation (with each commit, finished here)

The spec (tool table, sub-agent description), `docs/env.md` if a variable is added, the threat
model (new outbound content to the provider, SVG handling, the sub-agent's tool boundary),
`docs/operational-resilience.md` (provider error mid-job, unknown charge, model removed,
rasterizer limits), the user guide (how to ask for images, where they appear), ADR-0035 status
to Accepted.

## Test harness

**Unit (every push; offline, deterministic):**

| Test | Checks |
|---|---|
| `image-models.unit` | Every menu model has a kind, a format and a ceiling price; resolution by kind/tier/mission restriction; an unknown or restricted kind is refused |
| `pi-ai-patch.unit` | The patched `openrouter-images` `parseUsage` returns `providerCost` from a raw usage with `cost`, so a dependency upgrade that drops the patch fails a test |
| `image-client.unit` (stubbed HTTP) | Request shape per family; PNG and SVG parsing; provider charge recorded; **missing charge → ceiling estimate, flagged, never 0**; abort and timeout; oversized or wrong-type responses refused |
| `image-metering.unit` | A generation reaches `llmCallLog` and turn stats with its cost and `costEstimated`; the mission cap blocks a generation once reached; the calling agent's per-turn limits count it |
| `create-image-tool.unit` | Parameter validation; reference paths outside the permitted roots refused; budget overrides capped |
| `image-agent.seam.unit` (scripted model + fake image client) | The full loop deterministically: brief → generate ×N → critique → refine → finish; files and manifest written; **budget stops generation at `maxImages` and at `maxUsd`**; abort mid-loop leaves a valid partial manifest; refine reads the previous job; the sub-agent cannot reach any tool but its three |
| `image-job.unit` | Job id format; exclusive creation; a planted symlink in `shared/images/` refused; contact sheet escapes captions and embeds images |
| `svg-raster.unit` | Scripts and external references in an SVG do not execute or load during rasterization |

**Integration (real API; manual and nightly; about $1 per run):**
`image-models.integration`: one tiny generation per menu model — an image of the expected
format returns, the recorded cost is greater than zero, abort works. Skipped without
`OPENROUTER_API_KEY`.

**Scenario (spec for the scenario harness, `docs/plans/scenario-test-harness.md`):**
S-10 "Houseplant logo": the operator asks the Creative Director for a logo; passes when a job
folder has ≥ 4 candidates (≥ 2 SVG), a contact sheet, the job's total in `llmCallLog` is > $0
and ≤ $1.50, and the caller's reply names the contact sheet. Until the harness exists, run it
by hand on dev after Phase 2.

## Security checklist for the review (appsec's SC rows that apply)

SC-15 (inputs validated: brief, paths, budget), SC-16 (paths contained, no link following),
SC-19 (SVG never inlined; served as attachment, sandboxed), SC-22 (no key in the sub-agent or
files), SC-30 (briefs and reference images may carry injected instructions: the sub-agent has
no tool beyond its three), SC-31 (minimum tools), SC-32 (generated SVG never executed or
rendered unsandboxed), SC-33 (budget, turn limit, timeout, cap), SC-38 (only menu models with a
real or ceiling price).

## MAGI DEV's part (also a test of their usefulness)

| When | Agent | Ask |
|---|---|---|
| Before Phase 1 | appsec | Design review of ADR-0035 with the security controls checklist (task to send: "Design review of docs/adr/0035-image-generation-sub-agent.md") |
| Each commit | code reviewer | Change-completeness checklist |
| After Phase 2 | qa-lead | Journey review of a new journey J-18 "get images made" for the operator, the copilots and an agent; usability of the contact sheet |
| After Phase 4 | documenter | Documentation coverage for the new tool, settings and journey |

Claude Code scores each against what it found itself (CLAUDE.md, "MAGI DEV").

## Sequence and effort

| Phase | Effort |
|---|---|
| 0 Spike | ½ day |
| appsec review of the ADR (in parallel with the spike) | — |
| 1 Client and metering | 1 day |
| 2 Sub-agent and tool | 1–1½ days |
| 3 Cockpit and copilots | ½ day |
| 4 Documentation | throughout |

About 3–3½ days, then the live Houseplant demo.

## Progress log

- 2026-11-13 — plan agreed; ADR-0035 proposed.
- 2026-11-13 — appsec design review: approve with conditions (C-1 menu validation, C-2 patch ships with the tool, C-3 data class; config validation of `imageAgentModel`). C-1 as written relied on `hasRealPrice`, which accepts the $0 registry prices of per-image models; corrected in ADR-0035 decision 9 (menu entries need a ceiling price > 0). Also missed by the review, now in the ADR: escaping contact-sheet captions, size caps on reference images, the sub-agent's paragraph as untrusted output.
- 2026-11-13 — **Phase 0 spike done** (≈ $1.35 of live calls). Findings:
  - **Cost:** every image response carries `usage.cost` (FLUX and Recraft included), so extending the existing pi-ai patch to `api/openrouter-images.js` is sufficient. OpenRouter's per-request generation lookup often had no data yet seconds later: not used.
  - **Measured cost and latency per image:** Recraft vector $0.08 / pro-vector $0.30 (SVG, 44–48 KB, ~9 s); FLUX.2 Flex $0.05, **FLUX.2 Pro $0.03** (PNG ~300 KB, 7–8 s); Gemini 3.1 Flash Lite Image $0.034 (JPEG 67 KB, 3–4 s); Gemini 3 Pro Image $0.138 (PNG 616 KB, 2 s). FLUX.2 Flex at 16:9 via `image_config.aspect_ratio`: $0.10, a 3.8 MB PNG (size caps and downscaling needed).
  - **Quality (one logo brief):** FLUX.2 Pro and Recraft vector produced the best logos (correct lettering, clean assets); Gemini 3 Pro integrated leaf and bell best; Gemini Flash Lite delivered a mock-up on a card unless told otherwise (the prompt must ask for an isolated asset). Instruction editing with a reference image worked precisely (Gemini Flash Lite: "make the leaf gold" changed nothing else).
  - **SVG:** clean (no scripts, no external references, text as paths), with an embedded C2PA manifest. Rasterized in headless Chromium with JavaScript off and all non-data requests blocked in 0.1–0.4 s.
  - **Critique model:** Claude Sonnet 5 ($0.026, 21 s) caught every real defect and wrote an exact refinement instruction; Gemini 3.6 Flash ($0.009) stopped mid-answer. Default `imageAgentModel`: `anthropic/claude-sonnet-5`, with a generous output limit.
  - **Menu change:** FLUX.2 Pro serves both illustration tiers (cheaper and better than Flex).
  - **Ceiling prices** for the menu table (about twice the measured maximum): Recraft vector $0.16, pro-vector $0.60, FLUX.2 Pro $0.20 (larger sizes cost more), Gemini Flash Lite $0.08, Gemini 3 Pro $0.30.
