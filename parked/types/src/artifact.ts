export type ArtifactType =
  | "raw_data"
  | "processed_data"
  | "analysis"
  | "chart"
  | "report"
  | "code"
  | "notebook"
  | "alert_payload";

export type ArtifactEnvironment = "dev" | "prod";

export interface ArtifactLineage {
  /** Parent artifact IDs this artifact was derived from. */
  derivedFrom: string[];
  /** OTel trace ID of the producing tool call. */
  toolRunId?: string;
  /** Web URLs, data feed endpoints, or file paths. */
  sourceUrls: string[];
}

export interface Artifact {
  id: string;
  missionId: string;
  agentId: string;
  type: ArtifactType;
  environment: ArtifactEnvironment;
  name: string;
  description: string;
  mimeType: string;
  /** MinIO object key. */
  storagePath: string;
  sizeBytes?: number;
  /** SHA-256 of content binary. */
  contentHash?: string;
  lineage: ArtifactLineage;
  metadata: Record<string, unknown>;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. Set when promoted from dev to prod. */
  promotedAt?: string;
  /** Human approver identifier. */
  promotedBy?: string;
}
