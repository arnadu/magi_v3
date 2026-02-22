import type { MentalMapDocument, MentalMapPatch } from "./mental-map.js";
import type { Artifact } from "./artifact.js";

/**
 * Placeholder for pi-agent-core's AgentMessage type.
 * Replaced with:
 *   import type { AgentMessage } from "@mariozechner/pi-agent-core"
 * when pi-agent-core is added as a dependency in Sprint 1.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentMessage = Record<string, any>;

/**
 * Conversation history per agent session.
 * MongoDB-idiomatic interface — not backend-agnostic.
 * Injected at construction time; backed by mongodb-memory-server in tests.
 */
export interface ConversationRepository {
  append(sessionId: string, messages: AgentMessage[]): Promise<void>;
  load(sessionId: string): Promise<AgentMessage[]>;
  /** Prune to keep only the last N messages, preserving the system message. */
  truncate(sessionId: string, keepLast: number): Promise<void>;
}

/**
 * Per-agent Mental Map document.
 */
export interface MentalMapRepository {
  load(agentId: string): Promise<MentalMapDocument | null>;
  save(agentId: string, doc: MentalMapDocument): Promise<void>;
  /** Apply a surgical HTML patch and return the updated document. */
  patch(agentId: string, patch: MentalMapPatch): Promise<MentalMapDocument>;
}

export interface ArtifactFilter {
  type?: string;
  environment?: string;
  agentId?: string;
}

/**
 * Artifact registry. Binaries live in MinIO; this repository holds metadata.
 */
export interface ArtifactRepository {
  /** Persist artifact metadata and return the assigned artifact ID. */
  create(artifact: Artifact): Promise<string>;
  get(artifactId: string): Promise<Artifact | null>;
  queryByMission(
    missionId: string,
    filter?: ArtifactFilter
  ): Promise<Artifact[]>;
}
