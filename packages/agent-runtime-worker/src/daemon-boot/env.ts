/**
 * Parsed + validated boot-time environment. A discriminated return, not a
 * bare process.exitCode=1/return pair, since this validation runs as a
 * callee — main() itself owns the actual early-return/exit-code statement
 * (the plan's "pattern 1": a callee can't hide a return that must unwind
 * main()'s own scope).
 */
export type ParseDaemonEnvResult =
	| {
			ok: true;
			teamConfigPath: string | undefined;
			missionIdEnv: string | undefined;
			mongoUri: string;
			agentWorkdir: string;
	  }
	| { ok: false; exitMessage: string };

/**
 * Read and validate the env vars main() needs before it can do anything
 * else, logging each one's presence (not its value, for secrets) as it
 * goes — this log block is the first thing an operator checks when a
 * daemon fails to boot.
 */
export function parseDaemonEnv(
	dataKeyNames: readonly string[],
): ParseDaemonEnvResult {
	const teamConfigPath = process.env.TEAM_CONFIG;
	const missionIdEnv = process.env.MISSION_ID;
	const mongoUri = process.env.MONGODB_URI;
	const agentWorkdir = process.env.AGENT_WORKDIR ?? process.cwd();

	process.stdout.write(`[daemon] MISSION_ID=${missionIdEnv ?? "(unset)"}\n`);
	process.stdout.write(`[daemon] TEAM_CONFIG=${teamConfigPath ?? "(unset)"}\n`);
	process.stdout.write(
		`[daemon] MONGODB_URI=${mongoUri ? "(set)" : "(unset)"}\n`,
	);
	process.stdout.write(
		`[daemon] ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "(set)" : "(unset)"}\n`,
	);
	process.stdout.write(
		`[daemon] BRAVE_SEARCH_API_KEY=${process.env.BRAVE_SEARCH_API_KEY ? "(set)" : "(unset)"}\n`,
	);
	for (const key of dataKeyNames) {
		process.stdout.write(
			`[daemon] ${key}=${process.env[key] ? "(set)" : "(unset)"}\n`,
		);
	}

	if (!mongoUri) {
		return { ok: false, exitMessage: "Error: MONGODB_URI is required" };
	}
	if (!missionIdEnv && !teamConfigPath) {
		return {
			ok: false,
			exitMessage: "Error: MISSION_ID or TEAM_CONFIG is required",
		};
	}
	if (!process.env.ANTHROPIC_API_KEY) {
		return { ok: false, exitMessage: "Error: ANTHROPIC_API_KEY is required" };
	}

	return { ok: true, teamConfigPath, missionIdEnv, mongoUri, agentWorkdir };
}
