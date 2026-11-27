import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hasMagiCreateUser, resolveLinuxUsers, uidOf } from "../linux-user.js";
import {
	injectMissionCopilot,
	MISSION_COPILOT_AGENT_ID,
} from "../mission-copilot.js";
import type { BootContext } from "./context.js";
import { planUids, readUidMap, writeUidMap } from "./uid-map.js";

/**
 * Ensure every agent in the team config has a corresponding Linux OS user,
 * per resolveLinuxUsers() (linux-user.ts) — pool users in local dev, a
 * dedicated per-agent user derived from agent.id in production Docker.
 *
 * Production Docker (the `magi-create-user` helper is present): the users are
 * created at every boot, each with the uid pinned in the volume's uid map
 * (uid-map.ts), so a user keeps the uid its files on the volume are owned by
 * and granted to. The map is written before any user is created. A user that
 * already exists under another uid than its pinned one is fatal: running the
 * agent would hand it another agent's files.
 *
 * Local dev: the pool users exist (setup-dev.sh); a missing one is reported,
 * not fatal.
 */
export function ensureAgentUsers(
	agents: Array<{ id: string; linuxUser?: string }>,
	agentWorkdir: string,
	isUidTaken: (uid: number) => boolean = uidTaken,
): void {
	// execFileSync, not execSync: agent.id (CR-02) reaches this function
	// unvalidated beyond Zod's charset check (agent-config/src/loader.ts), and
	// execSync's template-string form runs through a shell — an id containing
	// shell metacharacters could inject arbitrary commands there.
	const users = [...new Set(resolveLinuxUsers(agents).values())];
	if (!hasMagiCreateUser()) {
		for (const linuxUser of users) {
			if (existingUid(linuxUser) === undefined) {
				console.warn(
					`[daemon] OS user ${linuxUser} does not exist and this machine has no magi-create-user; run scripts/setup-dev.sh — tools run as ${linuxUser} will fail`,
				);
			}
		}
		return;
	}
	const plan = planUids(
		readUidMap(agentWorkdir),
		users,
		existingUid,
		isUidTaken,
	);
	if (plan.mismatched.length > 0) {
		throw new Error(
			`Agent OS users exist under another uid than the volume pins (${plan.mismatched
				.map((m) => `${m.user}: ${m.actual}, pinned ${m.pinned}`)
				.join(
					"; ",
				)}): refusing to run agents as identities that own other agents' files`,
		);
	}
	writeUidMap(agentWorkdir, plan.map);
	for (const { user, uid } of plan.create) {
		execFileSync(
			"sudo",
			["/usr/local/bin/magi-create-user", user, String(uid)],
			{ stdio: "inherit" },
		);
		console.log(`[daemon] Created OS user ${user} (uid ${uid})`);
	}
}

function existingUid(linuxUser: string): number | undefined {
	try {
		return uidOf(linuxUser);
	} catch {
		return undefined;
	}
}

/** Whether any account holds `uid`, read from /etc/passwd (no subprocess). */
function uidTaken(uid: number): boolean {
	return readFileSync("/etc/passwd", "utf8")
		.split("\n")
		.some((line) => line.split(":")[2] === String(uid));
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
	ctx: Pick<BootContext, "teamConfig" | "missionId" | "workdir">,
	missionCopilotEnabled: boolean,
): Pick<BootContext, never> {
	if (missionCopilotEnabled) {
		injectMissionCopilot(ctx.teamConfig);
	}

	process.stdout.write(
		`[daemon] Mission: ${ctx.missionId} (${ctx.teamConfig.agents.length} agents)\n`,
	);

	process.stdout.write("[daemon] Ensuring agent OS users…\n");
	ensureAgentUsers(ctx.teamConfig.agents, ctx.workdir);

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
