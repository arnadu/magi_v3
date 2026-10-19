/**
 * Default model ids, used wherever a mission, an agent or the environment
 * names none (`MODEL`, `VISION_MODEL`). The worker's price table
 * (agent-runtime-worker/src/models.ts) is the only other place a model id
 * literal may appear (tripwire T15).
 */
export const DEFAULT_MODEL_ID = "claude-sonnet-4-6";
export const DEFAULT_VISION_MODEL_ID = "claude-haiku-4-5-20251001";
