import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentIdentity,
	buildAgentIdentity,
	type PoolRegistry,
	type WorkspaceLayout,
} from "./identity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceManagerOptions {
	layout: WorkspaceLayout;
	registry: PoolRegistry;
	/**
	 * When true, setfacl calls are skipped.
	 * Set automatically when pool users do not exist on the system.
	 * Always true in integration tests (no real pool users).
	 */
	skipAcl?: boolean;
}

// ---------------------------------------------------------------------------
// WorkspaceManager
// ---------------------------------------------------------------------------

export class WorkspaceManager {
	private readonly layout: WorkspaceLayout;
	private readonly registry: PoolRegistry;
	private readonly skipAcl: boolean;

	constructor(opts: WorkspaceManagerOptions) {
		this.layout = opts.layout;
		this.registry = opts.registry;
		this.skipAcl =
			opts.skipAcl ?? !poolUsersExist(opts.layout.poolUsers.slice(0, 1));
	}

	/**
	 * Assign pool users to agents, create per-mission directories, and apply
	 * setfacl on the shared artifacts folder.
	 *
	 * Returns a map of agentId → AgentIdentity for the mission.
	 */
	provision(
		missionId: string,
		agents: Array<{ id: string; role: string }>,
	): Map<string, AgentIdentity> {
		const identities = new Map<string, AgentIdentity>();

		for (const agent of agents) {
			const linuxUser = this.registry.assign(
				missionId,
				agent.id,
				this.layout.poolUsers,
			);
			const identity = buildAgentIdentity(
				missionId,
				agent.id,
				linuxUser,
				agent.role,
				this.layout,
			);
			identities.set(agent.id, identity);

			// Create the agent's private working directory.
			mkdirSync(identity.workdir, { recursive: true });
		}

		// Create the shared artifacts directory (one per mission, all agents share it).
		const sharedArtifactsDir = join(
			this.layout.missionsBase,
			missionId,
			"shared",
			"artifacts",
		);
		mkdirSync(sharedArtifactsDir, { recursive: true });

		// Apply setfacl so all pool users assigned to this mission can read/write
		// the shared artifacts directory.
		if (!this.skipAcl) {
			applySharedAcl(
				sharedArtifactsDir,
				Array.from(identities.values()).map((i) => i.linuxUser),
			);
		}

		return identities;
	}

	/**
	 * Remove all per-mission directories and release pool assignments.
	 * Pool users themselves are NOT removed — they persist for reuse.
	 */
	teardown(missionId: string, identities: Map<string, AgentIdentity>): void {
		for (const identity of identities.values()) {
			rmSync(identity.workdir, { recursive: true, force: true });
		}

		// Remove the shared mission folder entirely.
		const sharedDir = join(this.layout.missionsBase, missionId, "shared");
		rmSync(sharedDir, { recursive: true, force: true });

		this.registry.release(missionId);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether the given pool users exist as OS users on this system.
 * Used to decide whether setfacl calls are possible.
 */
function poolUsersExist(users: string[]): boolean {
	return users.every((u) => {
		const result = spawnSync("id", [u], { encoding: "utf-8" });
		return result.status === 0;
	});
}

/**
 * Apply ACL entries so the given linux users have rwx on the shared dir,
 * including default ACL so new files inherit the same permissions.
 */
function applySharedAcl(dir: string, linuxUsers: string[]): void {
	if (!isSetfaclAvailable()) return;

	for (const user of linuxUsers) {
		// Named user ACL entry: rwx
		execSync(`setfacl -m u:${user}:rwx "${dir}"`, { stdio: "ignore" });
		// Default ACL (inherited by files/dirs created inside)
		execSync(`setfacl -d -m u:${user}:rwx "${dir}"`, { stdio: "ignore" });
	}
}

function isSetfaclAvailable(): boolean {
	const r = spawnSync("which", ["setfacl"], { encoding: "utf-8" });
	return r.status === 0;
}
