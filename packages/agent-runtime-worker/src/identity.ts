import { join } from "node:path";

// ---------------------------------------------------------------------------
// Workspace layout configuration
// ---------------------------------------------------------------------------

/**
 * Describes where MAGI paths live on this host.
 *
 * Defaults are the production layout:
 *   homeBase    /home            → /home/magi-w1/missions/{missionId}/
 *   missionsBase /missions       → /missions/{missionId}/shared/artifacts/
 *
 * Tests override both to tmp dirs so no real users or root paths are needed.
 */
export interface WorkspaceLayout {
	/** Base directory containing pool user home dirs. Default: /home */
	homeBase: string;
	/** Root under which mission shared folders are created. Default: /missions */
	missionsBase: string;
	/** Ordered list of Linux pool user names. */
	poolUsers: string[];
}

export function defaultLayout(): WorkspaceLayout {
	return {
		homeBase: "/home",
		missionsBase: "/missions",
		poolUsers: [
			"magi-w1",
			"magi-w2",
			"magi-w3",
			"magi-w4",
			"magi-w5",
			"magi-w6",
		],
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
 *   linuxUser — OS pool member assigned for this mission (e.g. "magi-w1")
 */
export interface AgentIdentity {
	missionId: string;
	agentId: string;
	linuxUser: string;
	role: string;
	/** Private working directory: homeBase/linuxUser/missions/missionId */
	workdir: string;
	/** Shared artifacts directory: missionsBase/missionId/shared/artifacts */
	sharedArtifactsDir: string;
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
	const sharedArtifactsDir = join(
		layout.missionsBase,
		missionId,
		"shared",
		"artifacts",
	);
	return {
		missionId,
		agentId,
		linuxUser,
		role,
		workdir,
		sharedArtifactsDir,
		permittedPaths: [workdir, sharedArtifactsDir],
	};
}

// ---------------------------------------------------------------------------
// PoolRegistry — in-memory pool slot tracking
// ---------------------------------------------------------------------------

/**
 * Tracks which pool user is assigned to which agent within each mission.
 *
 * In production this is backed by MongoDB; here we provide an in-memory
 * implementation sufficient for development and integration tests.
 */
export class PoolRegistry {
	/** missionId → (agentId → linuxUser) */
	private readonly assignments = new Map<string, Map<string, string>>();
	/** missionId → Set<linuxUser currently in use> */
	private readonly used = new Map<string, Set<string>>();

	/**
	 * Assign a pool user to agentId for missionId, or return the existing
	 * assignment if one already exists.
	 *
	 * Throws if the pool is exhausted.
	 */
	assign(missionId: string, agentId: string, poolUsers: string[]): string {
		if (!this.assignments.has(missionId)) {
			this.assignments.set(missionId, new Map());
			this.used.set(missionId, new Set());
		}
		const missionMap = this.assignments.get(missionId) as Map<string, string>;
		const missionUsed = this.used.get(missionId) as Set<string>;

		const existing = missionMap.get(agentId);
		if (existing) return existing;

		const available = poolUsers.find((u) => !missionUsed.has(u));
		if (!available) {
			throw new Error(
				`Pool exhausted for mission "${missionId}": all ${poolUsers.length} slot(s) occupied. ` +
					`Increase MAGI_POOL_SIZE or wait for a mission to finish.`,
			);
		}

		missionMap.set(agentId, available);
		missionUsed.add(available);
		return available;
	}

	/** Return the assigned linux user for this agent, or undefined. */
	get(missionId: string, agentId: string): string | undefined {
		return this.assignments.get(missionId)?.get(agentId);
	}

	/** Release all pool slots for a mission (call after teardown). */
	release(missionId: string): void {
		this.assignments.delete(missionId);
		this.used.delete(missionId);
	}

	/** Return all current assignments for a mission (for logging/debug). */
	listAssignments(
		missionId: string,
	): Array<{ agentId: string; linuxUser: string }> {
		const map = this.assignments.get(missionId);
		if (!map) return [];
		return Array.from(map.entries()).map(([agentId, linuxUser]) => ({
			agentId,
			linuxUser,
		}));
	}
}
