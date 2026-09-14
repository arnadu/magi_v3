import { existsSync } from "node:fs";

const MAGI_CREATE_USER_PATH = "/usr/local/bin/magi-create-user";

/**
 * True in the execution-plane Docker image, false in local dev.
 * `scripts/setup-dev.sh` never installs this root-owned helper — it exists
 * only in the built image (agent-runtime-worker/Dockerfile) — so its presence
 * is the one reliable signal for which linuxUser derivation strategy applies.
 */
export function hasMagiCreateUser(): boolean {
	return existsSync(MAGI_CREATE_USER_PATH);
}

/**
 * Resolves every agent's Linux OS user identity for a mission's roster.
 *
 * An explicit `agent.linuxUser` always wins (kept for flexibility, though no
 * shipped template sets it anymore — see the linuxUser removal in
 * config/teams/*.yaml). For every agent without one:
 *
 * - Production Docker (`hasMagiCreateUser()` true): derive it from `agent.id`
 *   directly — `ensureAgentUsers()` creates a dedicated per-agent OS user via
 *   the root-owned `magi-create-user` helper at daemon startup.
 * - Local dev (no helper — see `scripts/setup-dev.sh`): a fresh real OS user
 *   per agent.id would permanently pollute the developer's own machine, so
 *   every agent instead maps onto the small, fixed pool `setup-dev.sh`
 *   creates once (`magi-w1..magi-wN`). Assignment is deterministic — agent
 *   ids needing a slot are sorted, then assigned pool slots in that order —
 *   so the same team config always maps onto the same users across restarts.
 *   Fails loudly (throws) rather than silently reusing a slot for two
 *   different agents if the team has more agents needing a slot than the
 *   pool has room for.
 *
 * `hasCreateUser` defaults to the real `hasMagiCreateUser()` check; tests
 * inject it directly rather than mocking the filesystem.
 */
export function resolveLinuxUsers(
	agents: ReadonlyArray<{ id: string; linuxUser?: string }>,
	hasCreateUser: boolean = hasMagiCreateUser(),
): Map<string, string> {
	const resolved = new Map<string, string>();
	const needsDerivation: string[] = [];
	for (const agent of agents) {
		if (agent.linuxUser) {
			resolved.set(agent.id, agent.linuxUser);
		} else {
			needsDerivation.push(agent.id);
		}
	}
	if (needsDerivation.length === 0) return resolved;

	if (hasCreateUser) {
		for (const id of needsDerivation) resolved.set(id, id);
		return resolved;
	}

	const poolSize = Number.parseInt(process.env.MAGI_POOL_SIZE ?? "6", 10);
	const sorted = [...needsDerivation].sort();
	if (sorted.length > poolSize) {
		throw new Error(
			`Local dev pool exhausted: ${sorted.length} agent(s) need a Linux user ` +
				`(${sorted.join(", ")}), but only ${poolSize} pool users ` +
				`(magi-w1..magi-w${poolSize}) exist. Run scripts/setup-dev.sh with a ` +
				"larger MAGI_POOL_SIZE, or reduce the team's agent count.",
		);
	}
	sorted.forEach((id, i) => {
		resolved.set(id, `magi-w${i + 1}`);
	});
	return resolved;
}
