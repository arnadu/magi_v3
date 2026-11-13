# Image generation — plan of action

Status: **agreed 2026-11-13, not started.** Decision record:
[ADR-0035](../adr/0035-image-generation-sub-agent.md) (Proposed until appsec's design review).
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
3. **Cost**: does the chat-completions response carry `usage.cost` (with
   `usage: { include: true }`)? If not, does `GET /api/v1/generation?id=<responseId>` return the
   charge, and how soon? Decide: pi-ai with an `onPayload` hook and the generation endpoint, or
   our own small client (one POST, full control of `usage`).
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
| `packages/agent-runtime-worker/src/images/image-client.ts` | One generation call: prompt, reference images (contained paths, size-capped), aspect ratio; returns images (bytes, mime type), the provider's charge (or the ceiling estimate, flagged), response id; honours `AbortSignal` and a timeout |
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
