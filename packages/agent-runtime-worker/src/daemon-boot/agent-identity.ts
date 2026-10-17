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
const MISSION_COPILOT_SRC_PROBE = `${MISSION_COPILOT_SRC_PATH}/MAGI_V3_SPEC.md`;

/**
 * Check that the mission copilot's OS user can read the bundled platform
 * source (ADR-0016), and report it either way.
 *
 * The grant itself is static: the execution-plane image creates the
 * `mission-copilot` user and ships /opt/magi-src owned by root, group
 * `mission-copilot`, mode 750. Nothing that runs at runtime — not even the
 * daemon, which a confused-deputy bug could drive — can then change what the
 * copilot reads and trusts, and Bash run by every other agent user gets EACCES:
 * Bash has no software path check (A-002), so the OS mode is the real
 * boundary, not AgentRunContext.permittedPaths (which only gates
 * WriteFile/EditFile).
 *
 * The probe runs the same `sudo -u <user> magi-node` path the copilot's own
 * tools use, so it fails exactly when the copilot would. Best-effort:
 * /opt/magi-src only exists in the built image, never in local dev.
 */
export function verifyMissionCopilotSourceAccess(linuxUser: string): boolean {
	if (!existsSync(MISSION_COPILOT_SRC_PATH)) return true;
	try {
		execFileSync(
			"sudo",
			[
				"-n",
				"-u",
				linuxUser,
				"/usr/local/bin/magi-node",
				"-e",
				`require("node:fs").accessSync(${JSON.stringify(MISSION_COPILOT_SRC_PROBE)}, 4)`,
			],
			{ stdio: "ignore", timeout: 10_000 },
		);
		console.log(
			`[daemon] ${linuxUser} can read ${MISSION_COPILOT_SRC_PATH} (platform source for the mission copilot)`,
		);
		return true;
	} catch (e) {
		console.error(
			`[daemon] ${linuxUser} cannot read ${MISSION_COPILOT_SRC_PATH}: ${(e as Error).message} — the mission copilot will diagnose without the platform source; the image is expected to ship it as root:${linuxUser} mode 750`,
		);
		return false;
	}
}

/**
 * Mission-copilot injection, OS-user provisioning, and the copilot's source-
 * access check, bundled because their order is load-bearing:
 *
 *   1. Mission-copilot injection must precede ensureAgentUsers — the
 *      copilot needs a real per-agent OS user and workspace ACL through the
 *      exact same path every other agent goes through.
 *   2. The source-access check must run after ensureAgentUsers — it runs as
 *      the copilot's OS user (agent id "mission-copilot"), which the image
 *      pre-creates in production but local dev maps onto a pool user.
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
			verifyMissionCopilotSourceAccess(copilotLinuxUser);
		}
	}

	return {};
}
