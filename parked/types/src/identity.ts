export type AgentEnvironment = "dev" | "prod";

export interface ModelConfig {
  /** Model identifier resolved from config/env at runtime. */
  outerLoop: string;
  innerLoop: string;
}

export interface ToolPolicy {
  outerLoopTools: string[];
  innerLoopTools: string[];
}

export interface SharedPathPolicy {
  /** Absolute path, e.g. /missions/{missionId}/shared/{role} */
  path: string;
  access: "read" | "write" | "read-write";
}

export interface WorkspacePolicy {
  /** Absolute path, e.g. /home/agents/{agentId} */
  homePath: string;
  sharedPaths: SharedPathPolicy[];
}

export interface AgentIdentity {
  agentId: string;
  missionId: string;
  /** Role string from team config; canonical values in AGENT_ROLES. */
  role: string;
  displayName: string;
  /** Linux UID assigned by identity-access-service. */
  uid: number;
  /** Linux GID; equals uid by convention. Groups added at workspace provisioning. */
  gid: number;
  environment: AgentEnvironment;
  models: ModelConfig;
  toolPolicy: ToolPolicy;
  workspacePolicy: WorkspacePolicy;
}

/** Canonical role identifiers. Team configs may use custom strings as well. */
export const AGENT_ROLES = [
  "lead_analyst",
  "junior_analyst",
  "data_scientist",
  "watcher",
  "supervisor",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];
