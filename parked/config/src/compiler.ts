import type { TeamConfig, AgentConfig } from "./schema.js";
import type {
  AgentIdentity,
  ToolPolicy,
  WorkspacePolicy,
} from "@magi/types";

/**
 * Starting UID for agent processes.
 * In production these are allocated by identity-access-service; this base is
 * used for local/dev compilation where real uid allocation is not available.
 */
const UID_BASE = 10_000;

export interface CompileResult {
  identities: AgentIdentity[];
}

/**
 * Compile a validated TeamConfig into runtime AgentIdentity objects.
 *
 * This is the dry-run compiler — it produces the policy objects that the
 * agent-runtime-worker and workspace-manager consume at mission startup.
 * UIDs are assigned sequentially from UID_BASE; identity-access-service
 * assigns real UIDs in production.
 */
export function compileTeamConfig(config: TeamConfig): CompileResult {
  const identities = config.agents.map((agent, index) =>
    compileAgentIdentity(config.mission.id, agent, UID_BASE + index)
  );
  return { identities };
}

function compileAgentIdentity(
  missionId: string,
  agent: AgentConfig,
  uid: number
): AgentIdentity {
  const toolPolicy: ToolPolicy = {
    outerLoopTools: agent.tools.outerLoop,
    innerLoopTools: agent.tools.innerLoop,
  };

  const workspacePolicy: WorkspacePolicy = {
    homePath: `/home/agents/${agent.id}`,
    sharedPaths: (agent.workspace?.sharedPaths ?? []).map((sp) => ({
      path: `/missions/${missionId}/shared/${sp.role}`,
      access: sp.access,
    })),
  };

  return {
    agentId: agent.id,
    missionId,
    role: agent.role,
    displayName: agent.displayName,
    // gid === uid by convention; additional groups added at workspace provisioning
    uid,
    gid: uid,
    environment: agent.environment,
    models: agent.models,
    toolPolicy,
    workspacePolicy,
  };
}
