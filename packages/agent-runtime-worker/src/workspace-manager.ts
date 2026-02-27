import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
	type AgentIdentity,
	buildAgentIdentity,
	type WorkspaceLayout,
} from "./identity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceManagerOptions {
	layout: WorkspaceLayout;
	/**
	 * When true, setfacl calls are skipped.
	 * Defaults to true when setfacl is not installed on the system.
	 * Always pass true in integration tests running on systems without setfacl.
	 */
	skipAcl?: boolean;
}

// ---------------------------------------------------------------------------
// WorkspaceManager
// ---------------------------------------------------------------------------

export class WorkspaceManager {
	private readonly layout: WorkspaceLayout;
	private readonly skipAcl: boolean;

	constructor(opts: WorkspaceManagerOptions) {
		this.layout = opts.layout;
		this.skipAcl = opts.skipAcl ?? !isSetfaclAvailable();
	}

	/**
	 * Create per-mission directories for each agent and apply setfacl on the
	 * shared mission directory.
	 *
	 * Returns a map of agentId → AgentIdentity for the mission.
	 */
	provision(
		missionId: string,
		agents: Array<{ id: string; role: string; linuxUser: string }>,
	): Map<string, AgentIdentity> {
		const identities = new Map<string, AgentIdentity>();

		for (const agent of agents) {
			const { linuxUser } = agent;
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

			// Apply mutual ACL so the agent's OS user can write to the workdir
			// (created by the orchestrator) and the orchestrator can read files
			// the agent created (e.g. for FetchUrl / InspectImage).
			if (!this.skipAcl) {
				applyWorkdirAcl(identity.workdir, linuxUser, userInfo().username);
			}
		}

		// Create the shared mission directory (one per mission, all agents share it).
		const sharedDir = join(this.layout.missionsBase, missionId, "shared");
		mkdirSync(sharedDir, { recursive: true });

		// Apply setfacl so all linux users assigned to this mission can read/write
		// the shared directory, including any files/dirs created inside it.
		if (!this.skipAcl) {
			applySharedAcl(
				sharedDir,
				Array.from(identities.values()).map((i) => i.linuxUser),
			);
		}

		return identities;
	}

	/**
	 * Remove all per-mission directories for the given identities.
	 * Linux users themselves are NOT removed — they persist on the system.
	 */
	teardown(missionId: string, identities: Map<string, AgentIdentity>): void {
		for (const identity of identities.values()) {
			rmSync(identity.workdir, { recursive: true, force: true });
		}

		// Remove the shared mission folder entirely.
		const sharedDir = join(this.layout.missionsBase, missionId, "shared");
		rmSync(sharedDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply mutual ACL on an agent's private workdir so:
 *   - `agentUser` (magi-w1) can write files created by the orchestrator.
 *   - `orchestratorUser` can read files created by the agent (FetchUrl etc.).
 * Default ACL entries ensure new files inherit the same permissions.
 */
function applyWorkdirAcl(
	dir: string,
	agentUser: string,
	orchestratorUser: string,
): void {
	if (!isSetfaclAvailable()) return;
	execSync(`setfacl -m u:${agentUser}:rwx "${dir}"`, { stdio: "ignore" });
	execSync(`setfacl -d -m u:${agentUser}:rwx "${dir}"`, { stdio: "ignore" });
	execSync(`setfacl -d -m u:${orchestratorUser}:rwx "${dir}"`, {
		stdio: "ignore",
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
