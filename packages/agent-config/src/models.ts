/**
 * Default model ids, used wherever a mission, an agent or the environment
 * names none (`MODEL`, `VISION_MODEL`). The worker's price table
 * (agent-runtime-worker/src/models.ts) is the only other place a model id
 * literal may appear (tripwire T15).
 */
export const DEFAULT_MODEL_ID = "claude-sonnet-4-6";
export const DEFAULT_VISION_MODEL_ID = "claude-haiku-4-5-20251001";
/** The image sub-agent's own model: it writes prompts and critiques candidates (ADR-0035). */
export const DEFAULT_IMAGE_AGENT_MODEL_ID = "anthropic/claude-sonnet-5";

/** Kinds of image job, each served by its own models in the worker's image menu (ADR-0035). */
export const IMAGE_KINDS = ["vector", "raster-art", "raster-instruct"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];
