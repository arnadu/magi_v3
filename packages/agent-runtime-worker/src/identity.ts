import { join } from "node:path";

// ---------------------------------------------------------------------------
// Workspace layout configuration
// ---------------------------------------------------------------------------

/**
 * Describes where MAGI paths live on this host.
 *
 * Defaults are the production layout:
 *   homeBase    /home      → /home/{linuxUser}/missions/{missionId}/
 *   missionsBase /missions → /missions/{missionId}/shared/
 *
 * Tests override both to tmp dirs so no root paths are needed.
 */
export interface WorkspaceLayout {
	/** Base directory containing agent home dirs. Default: /home */
	homeBase: string;
	/** Root under which mission shared folders are created. Default: /missions */
	missionsBase: string;
}

export function defaultLayout(): WorkspaceLayout {
	return {
		homeBase: "/home",
		missionsBase: "/missions",
	};
}

// ---------------------------------------------------------------------------
// AgentIdentity
// ---------------------------------------------------------------------------

/**
 * The resolved identity for one agent within one mission.
 *
 * Two-layer model:
 *   agentId   — semantic MAGI identity (e.g. "lead-analyst")
 *   linuxUser — OS user this agent runs as (e.g. "magi-w1")
 *              Required in the team YAML — no default.
 */
export interface AgentIdentity {
	missionId: string;
	agentId: string;
	linuxUser: string;
	role: string;
	/** Private working directory: homeBase/linuxUser/missions/missionId */
	workdir: string;
	/**
	 * Shared mission directory: missionsBase/missionId/shared
	 *
	 * Pass this to saveArtifact() so artifacts land under sharedDir/artifacts/{id}/,
	 * making them accessible to all agents on the mission.
	 */
	sharedDir: string;
	/** All absolute paths this agent is permitted to access. */
	permittedPaths: string[];
}

export function buildAgentIdentity(
	missionId: string,
	agentId: string,
	linuxUser: string,
	role: string,
	layout: WorkspaceLayout,
): AgentIdentity {
	const workdir = join(layout.homeBase, linuxUser, "missions", missionId);
	const sharedDir = join(layout.missionsBase, missionId, "shared");
	return {
		missionId,
		agentId,
		linuxUser,
		role,
		workdir,
		sharedDir,
		permittedPaths: [workdir, sharedDir],
	};
}
