# ADR-0005: Image Handling — Description-First

## Status
Accepted

## Context

Agents in the equity research scenario handle charts, screenshots, and downloaded images.
Including image binaries in every LLM turn is expensive (vision tokens) and often unnecessary
— most analytical tasks only need a text description, not the raw pixel data.

Candidates evaluated:
1. **Full vision call on every image reference** — maximum fidelity; maximum token cost
2. **Description-first with on-demand detail** — generate text description at ingest time;
   inject description into message history; `InspectImage` tool available for pixel-level
   detail on demand
3. **Skip images entirely** — not viable for charts and evidence artifacts

## Decision

Use **description-first**: generate an AI-authored text description of each image at upload
or fetch time; store the description alongside metadata in MongoDB; inject the description
(not the binary) into agent message history.

The `InspectImage` tool fetches the binary from MinIO and makes a vision LLM call when the
agent explicitly needs pixel-level detail (e.g. reading a chart value the description missed).

This approach is adapted directly from MAG_v2's `AgentAssetRegistry`, where it proved
approximately 80% token reduction in practice across multi-turn research sessions without
measurable loss in task accuracy for the primary use cases.

## Consequences

- **Sprint 3 (current implementation):**
  - `FetchUrl` downloads images from the Readability-extracted article body (not nav/UI)
    and auto-describes each via a vision LLM call at fetch time. Descriptions are embedded
    inline in `content.md` alongside the article text.
  - Images are stored in the artifact folder on disk (`artifacts/<id>/image-N.ext`).
    SVG is excluded (`VISION_MIMES` = jpeg, png, gif, webp) because the Anthropic API does
    not accept SVG.
  - `FetchUrl` limits vision calls to `max_images` (default 3) images per fetch to control
    cost. Agents may increase this up to 10 via the `max_images` parameter.
  - `InspectImage` is an inner-loop tool; it reads an image file within the workdir,
    makes a fresh vision LLM call, and returns the description as a text tool result.
    Image binaries are never embedded in conversation history.

- **Sprint 5+ (planned):**
  - `AgentAssetRegistry` will store image metadata + description in MongoDB; binary data
    in MinIO.
  - `FetchData` and `PublishArtifact` will auto-register images via `AgentAssetRegistry`.
  - Content hash (SHA-256) will be recorded; description regenerated if image changes.

- Token cost for image-heavy workflows is bounded by the number of `InspectImage` calls
  and the `max_images` setting on `FetchUrl`, not by the number of turns that reference
  an image.
