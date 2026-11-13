# ADR-0035: Image generation through a sub-agent tool, metered at the provider's charge

**Status:** Proposed (2026-11-13) — for appsec's design review before implementation
**Relates to:** ADR-0034 (spend containment), F-079 (models without a real price), F-051 (SVG
served as attachment), the Research tool (in-process sub-agent precedent), #104–#106 (machine
memory)

## Context

Missions need images: the Houseplant Grand Hotel mission needs a logo and illustrations for a
website; the meteorology textbook needs figures. OpenRouter's images endpoint offers 37 models
of three kinds:

- **diffusion / flow models** (FLUX.2, Seedream, Krea, Riverflow): best aesthetics and
  photorealism, descriptive prompts, priced per image;
- **multimodal language models with image output** (Gemini image, GPT image): best at complex
  instructions, layouts, legible text and conversational editing, priced per token;
- **vector models** (Recraft v4 vector): native SVG, the right output for logos and icons.

Producing a good image is a loop — brief, a few candidates, critique each against the brief,
refine — that brings many images and long descriptions into context. Done inside a working
agent's own turn, it crowds out that agent's real work.

Two facts about the plumbing shape the decision:

1. The model library MAGI uses (pi-ai) has an images API (`generateImages`) over OpenRouter's
   chat-completions endpoint with `modalities: ["image"]`. It computes `usage.cost` from its
   own registry prices — **$0 for FLUX, Recraft and most per-image models** — and discards the
   charge OpenRouter reports. Metering through it as-is would record every such image as free:
   the spend cap would never see image spend (the same class of hole as F-079). MAGI already
   fixed this for chat calls with a `patch-package` patch
   (`patches/@mariozechner+pi-ai+0.82.1.patch`, ed93db0) that surfaces OpenRouter's
   `usage.cost` as `usage.providerCost`; the patch covers `api/openai-completions.js` only, not
   the images path (`api/openrouter-images.js`).
2. The cost path of the platform (`resolveCallCost`, `llm-meter.ts`) already prefers a
   provider-reported cost (`providerCost`) when one is present.

## Decision

1. **One agent-facing tool, `CreateImage`, implemented as an in-process sub-agent** (the
   Research tool's structure: its own short loop, its own system prompt, its own budget, a
   long tool time limit). Input: a brief (purpose, audience, subject, style references as
   file paths, constraints such as "SVG" or "transparent background", text to render), the
   number of options, optional budget overrides, and optionally a previous job id and
   candidate to refine. Output: file paths, a contact sheet, and per candidate its prompt,
   model and a one-line rationale — a paragraph in the caller's context, not the images.
2. **Inside the sub-agent**, three tools and nothing else:
   - `generate_image` — one call to the images endpoint with a model from the menu below;
   - `critique_candidates` — one vision call that compares the current candidates against the
     brief (raster images directly; SVG rasterized first);
   - `finish` — writes the manifest and the contact sheet and returns the result.
   No Bash, no web access, no messaging, no file access beyond the job folder and the
   reference images the caller passed.
3. **A fixed model menu**, chosen by the sub-agent per job, each with a draft and a final tier:

   | Job | Draft | Final |
   |---|---|---|
   | Logos, icons, marks (SVG) | `recraft/recraft-v4.1-vector` | `recraft/recraft-v4.1-pro-vector` |
   | Illustrations, photoreal scenes | `black-forest-labs/flux.2-flex` | `black-forest-labs/flux.2-pro` |
   | Diagrams with labels, instruction edits | `google/gemini-3.1-flash-lite-image` | `google/gemini-3-pro-image` |

   The menu is code (a typed table with each model's kind and output format), extended by a
   commit, never by an agent. A mission may restrict it (`mission.imageModels`, optional).
4. **Metered at the provider's charge, never at a registry price.** The existing pi-ai patch is
   extended to `api/openrouter-images.js` so image responses carry `usage.providerCost` the way
   chat responses already do. Each generation records that cost through the existing meter (`llmCallLog`, turn
   statistics, the mission cap, the calling agent's limits). If the cost cannot be obtained,
   the call is recorded at the model's **ceiling price from the menu table** (a deliberately
   high estimate, marked estimated) — never $0. A menu model with no ceiling price cannot be
   added (unit test).
5. **Budgets** per `CreateImage` call: at most `maxImages` generations (default 8) and
   `maxUsd` (default $1.50), whichever comes first, plus the sub-agent's turn limit and a
   10-minute time limit. Abort and timeout stop the loop and leave a manifest of what was made.
6. **Files**: `shared/images/<job-id>/` with `candidate-N.<png|svg>`, `manifest.json` (brief,
   model, prompt, cost, critique per candidate) and `contact-sheet.html` (all candidates with
   their notes, images embedded so it renders in the Files panel's sandboxed preview). The job
   id is unguessable; files are created exclusively without following links (house helpers).
7. **SVG is untrusted output.** It is stored and served as a file only (never inlined into the
   cockpit or a prompt), already served as an attachment with a sandbox CSP (F-051), and
   rasterized for critique in an isolated headless page with scripts and network disabled.
8. **The sub-agent's own model** (briefing, prompt writing, critique) is a strong vision model
   set per mission (`mission.imageAgentModel`, default chosen in the implementation spike),
   because critique is where image quality is decided; generation uses the menu.

## Alternatives considered

- **A plain `GenerateImage` tool called directly by agents.** Simpler, but every agent must
  learn prompting per model family, and the iterate-and-inspect loop fills the caller's
  context. Kept as the sub-agent's internal tool instead.
- **ComfyUI pipelines.** Fine control (inpainting with masks, ControlNet, LoRA styles), but
  needs GPU machines and pipeline maintenance; nothing the current missions need. Revisit for
  brand-consistent series of many images.
- **One default model.** Each family is weak where another is strong (vector logos,
  photorealism, labelled diagrams); a menu chosen per job costs no more.
- **pi-ai's images API as-is.** It drops the provider's charge (Context, fact 1).
- **Our own image client instead of pi-ai.** Full control, but a second provider client to
  maintain; extending the patch MAGI already carries for the same problem is smaller.
- **User-drawn masks now.** None of the menu's models takes a mask through OpenRouter; editing
  is by instruction plus reference image. Marking a region on an image in the cockpit is
  deferred to the document-annotation feature, which serves images and documents alike.

## Consequences

- Agents get images at the cost of one tool call and a paragraph of context; the operator sees
  a contact sheet and chooses.
- Image spend is inside the cap, at the real price.
- A new provider surface: requests carry agent-written briefs and the caller's reference
  images to OpenRouter (the same provider as chat calls, no new key).
- Rasterizing SVG uses a headless browser: it must share the per-machine browser limit of #105
  and counts toward the machine memory concern of #104.
- New failure modes for `docs/operational-resilience.md`: provider error or timeout mid-job
  (partial manifest), an unknown charge (ceiling estimate), a model removed from OpenRouter
  (menu entry fails, the sub-agent falls back within its kind).
