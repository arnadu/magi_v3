/**
 * The only way the daemon runs git against a mission's shared workspace.
 *
 * SECURITY (GIT1/CHAIN-A, 2026-10-15 audit): `shared/` is writable by every
 * agent, and the daemon runs git there after every turn with its own
 * identity and environment (which holds the cluster-wide MONGODB_URI and
 * provider keys). With the git directory at `shared/.git`, an agent could
 * plant a hook, a `core.fsmonitor` command, or a filter driver plus a
 * `.gitattributes` entry, and the daemon's next `git add`/`git status`
 * would execute it. `-c` overrides alone cannot close this — there is no
 * single flag that disables every config-defined filter or helper — so the
 * git directory itself lives outside the agent-writable tree, beside
 * `shared/` in the daemon-owned mission directory (`shared.git`), where
 * agents can read history but not write config. On top of that, every call:
 *   - passes `--git-dir`/`--work-tree` explicitly, so an agent-created
 *     `shared/.git` (file or directory) is never consulted;
 *   - ignores global and system config (`GIT_CONFIG_GLOBAL=/dev/null`,
 *     `GIT_CONFIG_NOSYSTEM=1`, a nonexistent HOME);
 *   - disables hooks and fsmonitor on the command line;
 *   - runs with a minimal explicit env — never the daemon's secrets.
 * The repository's own `config` file is rewritten to fixed content on every
 * boot (`ensureSharedGitDir`), so anything carried over from a legacy
 * agent-writable `shared/.git` cannot persist.
 */

import { execFile, execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);

const FIXED_CONFIG =
	"[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n";

/** The daemon-owned git directory for a mission's shared workspace. */
export function sharedGitDir(sharedDir: string): string {
	return join(dirname(sharedDir), "shared.git");
}

export function hardenedGitEnv(): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: "/nonexistent",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
}

export function hardenedGitArgs(sharedDir: string, args: string[]): string[] {
	return [
		"--git-dir",
		sharedGitDir(sharedDir),
		"--work-tree",
		sharedDir,
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"core.fsmonitor=false",
		// safe.directory is a protected setting: honored from the command line,
		// never from repo config. Both paths here are daemon-derived.
		"-c",
		"safe.directory=*",
		...args,
	];
}

export function runGit(
	sharedDir: string,
	args: string[],
): Promise<{ stdout: string }> {
	return pexec("git", hardenedGitArgs(sharedDir, args), {
		env: hardenedGitEnv(),
	});
}

function runGitSync(sharedDir: string, args: string[]): void {
	execFileSync("git", hardenedGitArgs(sharedDir, args), {
		env: hardenedGitEnv(),
		stdio: "ignore",
	});
}

/**
 * A legacy `shared/.git` was agent-writable, so a top-level entry in it may
 * be a symlink an agent planted (e.g. `objects` → somewhere the daemon would
 * then write). Only a real directory with no symlinked top-level entries is
 * migrated; anything else is discarded in favor of a fresh repository.
 */
function isSafeToMigrate(legacy: string): boolean {
	if (!lstatSync(legacy).isDirectory()) return false;
	return readdirSync(legacy).every(
		(name) => !lstatSync(join(legacy, name)).isSymbolicLink(),
	);
}

/**
 * Make sure the daemon-owned git directory exists for `sharedDir`, migrating
 * a legacy `shared/.git` into it when safe, or creating a new repository with
 * an empty initial commit. Always rewrites the repository config to fixed
 * content and removes the hooks directory. Idempotent; call at every boot.
 */
export function ensureSharedGitDir(sharedDir: string): void {
	const gitDir = sharedGitDir(sharedDir);
	const legacy = join(sharedDir, ".git");
	let needsInitialCommit = false;

	if (!existsSync(gitDir)) {
		if (existsSync(legacy) && isSafeToMigrate(legacy)) {
			renameSync(legacy, gitDir);
		} else {
			if (existsSync(legacy)) {
				console.warn(
					`[safe-git] Discarding unsafe legacy ${legacy} (not a plain directory, or contains symlinks) — starting a fresh history in ${gitDir}`,
				);
				rmSync(legacy, { recursive: true, force: true });
			}
			mkdirSync(gitDir);
			execFileSync("git", ["--git-dir", gitDir, "init", "-q", "-b", "main"], {
				env: hardenedGitEnv(),
				stdio: "ignore",
			});
			needsInitialCommit = true;
		}
	}

	// rm-then-create: a planted `config` symlink must not redirect this write.
	const configPath = join(gitDir, "config");
	rmSync(configPath, { force: true });
	writeFileSync(configPath, FIXED_CONFIG, { flag: "wx" });
	rmSync(join(gitDir, "hooks"), { recursive: true, force: true });

	if (needsInitialCommit) {
		runGitSync(sharedDir, [
			"-c",
			"user.name=magi",
			"-c",
			"user.email=magi@magi",
			"commit",
			"--allow-empty",
			"-q",
			"-m",
			"chore: initialise mission workspace",
		]);
	}
}
