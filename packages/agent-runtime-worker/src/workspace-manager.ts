import { execFileSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSharedGitDir } from "./safe-git.js";

/**
 * Default platform skills path: packages/skills/ resolved from the compiled
 * dist/ output at runtime, so it works wherever the package is installed.
 */
const DEFAULT_PLATFORM_SKILLS = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"skills",
);

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
 * The OS user comes from resolveLinuxUsers (linux-user.ts): a dedicated
 * per-agent user in production Docker, a fixed dev-pool user locally.
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
 * Mission filesystem provisioning, in production and locally alike.
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
	private readonly platformSkillsPath: string;
	private readonly teamSkillsPath: string | undefined;

	constructor(opts: {
		layout: WorkspaceLayout;
		/** Path to platform skill packages. Defaults to packages/skills/. */
		platformSkillsPath?: string;
		/** Path to team-specific skill packages (optional). */
		teamSkillsPath?: string;
	}) {
		this.layout = opts.layout;
		this.platformSkillsPath =
			opts.platformSkillsPath ?? DEFAULT_PLATFORM_SKILLS;
		this.teamSkillsPath = opts.teamSkillsPath;
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
		agents: Array<{ id: string; linuxUser: string }>,
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
			// Private means private: no "other" bits, so another agent's OS user
			// cannot read this tree. The agent and the daemon get in through the
			// named ACL entries below (mkdir's mode is umask-dependent and does
			// not touch a directory that already exists, hence the explicit chmod).
			chmodSync(workdir, 0o700);
			applyWorkdirAcl(workdir, linuxUser, userInfo().username);
			identities.set(agent.id, { workdir, sharedDir, linuxUser });
		}

		mkdirSync(sharedDir, { recursive: true });
		const linuxUsers = Array.from(identities.values()).map((i) => i.linuxUser);
		applySharedAcl(sharedDir, linuxUsers, userInfo().username);

		// Copy platform/team skills, create per-agent skill dirs, init git repo.
		provisionSkills(
			sharedDir,
			linuxUsers,
			this.platformSkillsPath,
			this.teamSkillsPath,
		);
		// Copy non-skill teamFiles (playbooks, reference docs, etc.) to sharedDir so
		// agent prompts that reference {{sharedDir}}/some-file.md find them at runtime.
		if (this.teamSkillsPath) {
			copyTeamFilesToSharedDir(
				sharedDir,
				dirname(this.teamSkillsPath),
				linuxUsers,
			);
		}
		for (const identity of identities.values()) {
			mkdirSync(join(identity.workdir, "skills"), { recursive: true });
		}

		ensureSharedGitDir(sharedDir);

		return identities;
	}

	/**
	 * Remove all per-mission directories for the given identities.
	 * OS users themselves are NOT removed — they persist on the system.
	 */
	teardown(missionId: string, identities: Map<string, AgentIdentity>): void {
		for (const identity of identities.values()) {
			try {
				rmSync(identity.workdir, { recursive: true, force: true });
			} catch (e) {
				console.error(
					`[workspace] teardown: failed to remove ${identity.workdir}: ${(e as Error).message}`,
				);
			}
		}
		// Remove the entire per-mission directory (shared/ and its daemon-owned shared.git).
		const missionDir = join(this.layout.missionsBase, missionId);
		try {
			rmSync(missionDir, { recursive: true, force: true });
		} catch (e) {
			console.error(
				`[workspace] teardown: failed to remove ${missionDir}: ${(e as Error).message}`,
			);
		}
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
 * The orchestrator user is also added to the default ACL so it can always
 * read and delete files created by pool users (git objects, reports, etc.)
 * without requiring sudo. Mirrors what applyWorkdirAcl does for workdirs.
 *
 * Uses execFileSync (no shell) to prevent injection via user values.
 * Throws if setfacl is not installed — OS-level isolation requires it.
 */
function applySharedAcl(
	dir: string,
	linuxUsers: string[],
	orchestratorUser: string,
): void {
	for (const user of linuxUsers) {
		execFileSync("setfacl", ["-m", `u:${user}:rwx`, dir], { stdio: "ignore" });
		execFileSync("setfacl", ["-d", "-m", `u:${user}:rwx`, dir], {
			stdio: "ignore",
		});
	}
	// Orchestrator needs default ACL so subdirs created by pool users (e.g.
	// git object directories committed by magi-wN) remain deletable by the
	// orchestrator during teardown without sudo.
	execFileSync("setfacl", ["-m", `u:${orchestratorUser}:rwx`, dir], {
		stdio: "ignore",
	});
	execFileSync("setfacl", ["-d", "-m", `u:${orchestratorUser}:rwx`, dir], {
		stdio: "ignore",
	});
}

/**
 * Create the skills directory tree under sharedDir, copy platform and team
 * skills into it, and apply the correct ACLs for each tier:
 *   _platform/ and _team/ — read-only for agents (r-x)
 *   mission/              — read-write for agents (rwx); agents create skills here
 *
 * Missing source dirs are silently skipped.
 */
function provisionSkills(
	sharedDir: string,
	linuxUsers: string[],
	platformSkillsPath: string,
	teamSkillsPath: string | undefined,
): void {
	const skillsRoot = join(sharedDir, "skills");
	const platformDest = join(skillsRoot, "_platform");
	const teamDest = join(skillsRoot, "_team");
	const missionDest = join(skillsRoot, "mission");

	// The tier directories are copied into as the daemon, so a symlink an agent
	// managed to plant at one of these paths would redirect that copy: refuse
	// to write through anything that is not a plain directory.
	for (const p of [skillsRoot, platformDest, teamDest, missionDest]) {
		let st: ReturnType<typeof lstatSync> | undefined;
		try {
			st = lstatSync(p);
		} catch {
			continue;
		}
		if (!st.isDirectory()) {
			throw new Error(
				`[workspace] ${p} exists but is not a directory (${st.isSymbolicLink() ? "symlink" : "file"}) — refusing to provision skills through it`,
			);
		}
	}
	mkdirSync(platformDest, { recursive: true });
	mkdirSync(teamDest, { recursive: true });
	mkdirSync(missionDest, { recursive: true });

	if (existsSync(platformSkillsPath)) {
		cpSync(platformSkillsPath, platformDest, { recursive: true });
	}
	if (teamSkillsPath && existsSync(teamSkillsPath)) {
		cpSync(teamSkillsPath, teamDest, { recursive: true });
	}

	for (const user of linuxUsers) {
		// skills/ itself: traverse and list only. Agents inherit rwx on it from
		// sharedDir's default ACL, which would let them rename or replace
		// _platform/_team wholesale even though the files inside are r-x
		// (unlink/rename needs write on the parent). An explicit r-x entry
		// on the directory overrides the inherited one for this user.
		execFileSync("setfacl", ["-m", `u:${user}:r-x`, skillsRoot], {
			stdio: "ignore",
		});
		// _platform and _team: read-only; apply recursively to cover copied files.
		execFileSync("setfacl", ["-R", "-m", `u:${user}:r-x`, platformDest], {
			stdio: "ignore",
		});
		execFileSync("setfacl", ["-d", "-m", `u:${user}:r-x`, platformDest], {
			stdio: "ignore",
		});
		execFileSync("setfacl", ["-R", "-m", `u:${user}:r-x`, teamDest], {
			stdio: "ignore",
		});
		execFileSync("setfacl", ["-d", "-m", `u:${user}:r-x`, teamDest], {
			stdio: "ignore",
		});
		// mission: read-write so agents can create team skills here.
		execFileSync("setfacl", ["-m", `u:${user}:rwx`, missionDest], {
			stdio: "ignore",
		});
		execFileSync("setfacl", ["-d", "-m", `u:${user}:rwx`, missionDest], {
			stdio: "ignore",
		});
	}
}

/**
 * Copy non-skill teamFiles from teamDir directly into sharedDir.
 *
 * The daemon writes all teamFiles to /missions/team/{path}. provisionSkills()
 * copies the skills/ sub-tree to sharedDir/skills/_team/, but any other files
 * (playbooks, reference docs, etc.) remain only at /missions/team/ — never
 * reaching sharedDir. This function closes that gap so agent prompts that
 * reference {{sharedDir}}/some-file.md find the file at the expected path.
 *
 * Files under teamDir/skills/ are skipped here — they are handled by
 * provisionSkills() above.
 *
 * `objectives/` used to need special seed-if-missing handling here (an
 * incident-driven interim patch — a resume-time overwrite of evolved,
 * on-disk objectives data with a stale MongoDB snapshot). That's no longer a
 * concern: objectives moved fully into MongoDB (ADR-0019) and nothing writes
 * to sharedDir/objectives/ at runtime anymore, so a plain overwrite-on-resume
 * here is harmless — the daemon's boot-time migration step reads these files
 * (if present) into Mongo once and never touches them again.
 */
export function copyTeamFilesToSharedDir(
	sharedDir: string,
	teamDir: string,
	linuxUsers: string[],
): void {
	if (!existsSync(teamDir)) return;

	function walk(dir: string): void {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const src = join(dir, name);
			const rel = relative(teamDir, src);
			// Skills are handled by provisionSkills() — skip.
			if (
				rel === "skills" ||
				rel.startsWith("skills/") ||
				rel.startsWith("skills\\")
			)
				continue;
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(src);
			} catch {
				continue;
			}
			const dest = join(sharedDir, rel);
			if (st.isDirectory()) {
				mkdirSync(dest, { recursive: true });
				walk(src);
				// Grant all agent users rwx on new subdirs.
				for (const user of linuxUsers) {
					try {
						execFileSync("setfacl", ["-m", `u:${user}:r-x`, dest], {
							stdio: "ignore",
						});
					} catch {
						/* best-effort */
					}
				}
			} else {
				mkdirSync(dirname(dest), { recursive: true });
				try {
					writeFileSync(dest, readFileSync(src));
					for (const user of linuxUsers) {
						try {
							execFileSync("setfacl", ["-m", `u:${user}:r--`, dest], {
								stdio: "ignore",
							});
						} catch {
							/* best-effort */
						}
					}
				} catch {
					/* skip unreadable files */
				}
			}
		}
	}
	walk(teamDir);
}
