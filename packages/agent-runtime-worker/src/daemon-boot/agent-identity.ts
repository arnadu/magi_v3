import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveLinuxUsers } from "../linux-user.js";
import {
	injectMissionCopilot,
	MISSION_COPILOT_AGENT_ID,
} from "../mission-copilot.js";
import type { BootContext } from "./context.js";

/**
 * Ensure every agent in the team config has a corresponding Linux OS user,
 * per resolveLinuxUsers() (linux-user.ts) — pool users in local dev, a
 * dedicated per-agent user derived from agent.id in production Docker.
 *
 * In dev/test environments the resolved pool users are created by
 * setup-dev.sh and already exist — execFileSync("id", [...]) succeeds and
 * this function is a no-op for each such agent.
 *
 * In production Docker, the Dockerfile only creates the magi-shared group;
 * this function creates per-agent OS users at first startup.
 *
 * Idempotent: if the user already exists, the step is skipped silently.
 */
export function ensureAgentUsers(
	agents: Array<{ id: string; linuxUser?: string }>,
): void {
	// execFileSync, not execSync: agent.id (CR-02) reaches this function
	// unvalidated beyond Zod's charset check (agent-config/src/loader.ts), and
	// execSync's template-string form runs through a shell — an id containing
	// shell metacharacters could inject arbitrary commands there. execFileSync
	// passes each argument directly to the OS, never through a shell, so
	// there's nothing for an id to inject into (found live during the 28c
	// security pass, 2026-09-13).
	for (const linuxUser of resolveLinuxUsers(agents).values()) {
		try {
			execFileSync("id", [linuxUser], { stdio: "ignore" });
		} catch {
			// User does not exist — create it.
			// In Docker (production) we use sudo magi-create-user which runs as root.
			// In local dev, resolveLinuxUsers() only ever returns existing pool
			// users, so this path is rarely reached there.
			try {
				execFileSync("sudo", ["/usr/local/bin/magi-create-user", linuxUser], {
					stdio: "inherit",
				});
				console.log(`[daemon] Created OS user: ${linuxUser}`);
			} catch (e) {
				// Non-fatal in local dev: pool users cover the common dev agents.
				// Fatal in Docker because setfacl will fail on the missing user.
				console.warn(
					`[daemon] Could not create OS user ${linuxUser}: ${(e as Error).message}`,
				);
			}
		}
	}
}

const MISSION_COPILOT_SRC_PATH = "/opt/magi-src";

/**
 * Grant the mission copilot's specific OS user read access to the bundled
 * platform source (ADR-0016).
 *
 * Why this can't be a Dockerfile permission alone: Bash has no software
 * checkPath — path enforcement for Bash is delegated entirely to OS Linux
 * ACLs (accepted finding A-002). AgentRunContext.permittedPaths (extended
 * for the copilot in agent-runner.ts) only gates WriteFile/EditFile. If
 * /opt/magi-src/ were world-or-group readable at the OS level, *any* agent
 * could read it via Bash regardless of permittedPaths — the actual
 * restriction has to be an OS-level ACL grant scoped to one specific Linux
 * user, the same setfacl-per-agent pattern WorkspaceManager already uses for
 * sharedDir/workdir. That user (agent id "mission-copilot") doesn't exist until
 * ensureAgentUsers() creates it, so this must run at daemon startup, not at
 * image build time — the Dockerfile only makes the directory readable by
 * magi-operator itself (mode 750, owned by magi-operator's own dedicated
 * group — confirmed via a real image build), not by any other user.
 *
 * Best-effort: /opt/magi-src/ only exists in the built execution-plane
 * image, never in local dev — skip silently when absent, matching every
 * other ACL call's tolerance for unsupported/missing environments.
 */
export function grantMissionCopilotSourceAccess(linuxUser: string): void {
	if (!existsSync(MISSION_COPILOT_SRC_PATH)) return;
	try {
		execFileSync(
			"setfacl",
			["-R", "-m", `u:${linuxUser}:rX`, MISSION_COPILOT_SRC_PATH],
			{ stdio: "ignore" },
		);
		console.log(
			`[daemon] Granted ${linuxUser} read access to ${MISSION_COPILOT_SRC_PATH}`,
		);
	} catch (e) {
		console.error(
			`[daemon] Failed to grant ${linuxUser} access to ${MISSION_COPILOT_SRC_PATH}: ${(e as Error).message}`,
		);
	}
}

/**
 * Mission-copilot injection, OS-user provisioning, and the copilot's source-
 * access ACL grant, bundled into one extraction rather than three: this is
 * the file's clearest load-bearing sequential-ordering example, and
 * splitting it across separate commits risks a later one disturbing the
 * order. The two ordering constraints below are the reason it's bundled:
 *
 *   1. Mission-copilot injection must precede ensureAgentUsers — the
 *      copilot needs a real per-agent OS user and workspace ACL through the
 *      exact same path every other agent goes through.
 *   2. The ACL grant must run after ensureAgentUsers — the copilot's OS
 *      user (agent id "mission-copilot") doesn't exist until that call
 *      creates it.
 */
export function provisionAgentIdentities(
	ctx: Pick<BootContext, "teamConfig" | "missionId">,
	missionCopilotEnabled: boolean,
): Pick<BootContext, never> {
	if (missionCopilotEnabled) {
		injectMissionCopilot(ctx.teamConfig);
	}

	process.stdout.write(
		`[daemon] Mission: ${ctx.missionId} (${ctx.teamConfig.agents.length} agents)\n`,
	);

	process.stdout.write("[daemon] Ensuring agent OS users…\n");
	ensureAgentUsers(ctx.teamConfig.agents);

	if (missionCopilotEnabled) {
		const copilotLinuxUser = resolveLinuxUsers(ctx.teamConfig.agents).get(
			MISSION_COPILOT_AGENT_ID,
		);
		if (copilotLinuxUser) {
			grantMissionCopilotSourceAccess(copilotLinuxUser);
		}
	}

	return {};
}
