import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Describes where MAGI paths live on this host / container.
 *
 * Production layout:
 *   homeBase     /home      → /home/{linuxUser}/missions/{missionId}/
 *   missionsBase /missions  → /missions/{missionId}/shared/
 *
 * Tests override both to temp dirs so no root paths are needed.
 */
export interface WorkspaceLayout {
	homeBase: string;
	missionsBase: string;
}

/**
 * Resolved filesystem paths for one agent within one mission.
 *
 * Dev-mode stopgap: in production this struct is replaced by a control-plane
 * record (MongoDB document) that also carries uid, gid, policy tags, etc.
 * The control plane creates a dedicated OS user per agent per mission at
 * mission startup; here we reuse pre-existing dev users from the team YAML.
 */
export interface AgentIdentity {
	/** Private working directory: homeBase/linuxUser/missions/missionId */
	workdir: string;
	/** Shared mission directory: missionsBase/missionId/shared */
	sharedDir: string;
	/** OS user this agent's tools execute as (via sudo). */
	linuxUser: string;
}

// ---------------------------------------------------------------------------
// WorkspaceManager
// ---------------------------------------------------------------------------

/**
 * Dev-mode stopgap for mission filesystem provisioning.
 *
 * Creates per-agent private workdirs and the shared mission dir, then applies
 * setfacl so each agent's OS user can access its own dir and all agents can
 * access the shared dir. Tears everything down when the mission ends.
 *
 * Does NOT create or delete OS users — that is the control plane's job
 * (Sprint 6+). In dev, OS users are pre-created by scripts/setup-dev.sh.
 */
export class WorkspaceManager {
	private readonly layout: WorkspaceLayout;

	constructor(opts: { layout: WorkspaceLayout }) {
		this.layout = opts.layout;
	}

	/**
	 * Create per-mission directories for each agent and apply setfacl.
	 *
	 * setfacl is always applied — OS-level isolation is not optional.
	 * Throws if setfacl is not installed.
	 *
	 * Returns a map of agentId → AgentIdentity for the mission.
	 */
	provision(
		missionId: string,
		agents: Array<{ id: string; role: string; linuxUser: string }>,
	): Map<string, AgentIdentity> {
		const sharedDir = join(this.layout.missionsBase, missionId, "shared");
		const identities = new Map<string, AgentIdentity>();

		for (const agent of agents) {
			const { linuxUser } = agent;
			const workdir = join(
				this.layout.homeBase,
				linuxUser,
				"missions",
				missionId,
			);
			mkdirSync(workdir, { recursive: true });
			applyWorkdirAcl(workdir, linuxUser, userInfo().username);
			identities.set(agent.id, { workdir, sharedDir, linuxUser });
		}

		mkdirSync(sharedDir, { recursive: true });
		applySharedAcl(
			sharedDir,
			Array.from(identities.values()).map((i) => i.linuxUser),
		);

		return identities;
	}

	/**
	 * Remove all per-mission directories for the given identities.
	 * OS users themselves are NOT removed — they persist on the system.
	 */
	teardown(missionId: string, identities: Map<string, AgentIdentity>): void {
		for (const identity of identities.values()) {
			rmSync(identity.workdir, { recursive: true, force: true });
		}
		// Remove the entire per-mission directory (contains shared/ and nothing else).
		rmSync(join(this.layout.missionsBase, missionId), {
			recursive: true,
			force: true,
		});
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply mutual ACL on an agent's private workdir so:
 *   - `agentUser` can write files created by the orchestrator.
 *   - `orchestratorUser` can read files the agent created (FetchUrl etc.).
 * Default ACL entries ensure new files inherit the same permissions.
 *
 * Uses execFileSync (no shell) to prevent injection via agentUser values.
 * Throws if setfacl is not installed — OS-level isolation requires it.
 */
function applyWorkdirAcl(
	dir: string,
	agentUser: string,
	orchestratorUser: string,
): void {
	execFileSync("setfacl", ["-m", `u:${agentUser}:rwx`, dir], {
		stdio: "ignore",
	});
	execFileSync("setfacl", ["-d", "-m", `u:${agentUser}:rwx`, dir], {
		stdio: "ignore",
	});
	execFileSync("setfacl", ["-d", "-m", `u:${orchestratorUser}:rwx`, dir], {
		stdio: "ignore",
	});
}

/**
 * Apply ACL entries so the given linux users have rwx on the shared dir,
 * including default ACL so new files inherit the same permissions.
 *
 * Uses execFileSync (no shell) to prevent injection via user values.
 * Throws if setfacl is not installed — OS-level isolation requires it.
 */
function applySharedAcl(dir: string, linuxUsers: string[]): void {
	for (const user of linuxUsers) {
		execFileSync("setfacl", ["-m", `u:${user}:rwx`, dir], { stdio: "ignore" });
		execFileSync("setfacl", ["-d", "-m", `u:${user}:rwx`, dir], {
			stdio: "ignore",
		});
	}
}
