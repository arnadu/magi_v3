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

- `AgentAssetRegistry` stores image metadata + description in MongoDB; binary data in MinIO.
- Image descriptions include: content hash (SHA-256), original URL or upload source,
  timestamp, MIME type, dimensions, and the LLM-generated description text.
- `FetchData` and `PublishArtifact` auto-register images via `AgentAssetRegistry` when the
  MIME type is an image.
- `InspectImage` is an inner-loop tool; it performs a vision call and returns the result
  as a text tool result. The image binary is never embedded in conversation history.
- The description is regenerated if the content hash changes (image updated at source).
- Token cost for image-heavy workflows is bounded by the number of `InspectImage` calls,
  not by the number of turns that reference an image.
