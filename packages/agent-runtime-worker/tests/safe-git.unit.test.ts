import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ensureSharedGitDir,
	hardenedGitEnv,
	runGit,
	sharedGitDir,
} from "../src/safe-git.js";
import { WorkspaceGit } from "../src/workspace-git.js";

/**
 * GIT1/CHAIN-A (2026-10-15 audit). Real git, throwaway dirs. The old daemon
 * ran `git -C shared add/commit` with its own env against an agent-writable
 * `shared/.git`; a planted hook printed the daemon's MONGODB_URI (reproduced
 * before this fix). Every test plants an attacker program that would create
 * a marker file if executed, then asserts the marker never appears.
 */

let base: string;
let shared: string;
let marker: string;

function evilScript(name: string): string {
	const p = join(base, name);
	writeFileSync(p, `#!/bin/sh\ntouch ${marker}\ncat\n`);
	chmodSync(p, 0o755);
	return p;
}

/** The old layout: a repo whose git dir is `shared/.git`, agent-writable. */
function legacyRepo(): void {
	execFileSync("git", ["-C", shared, "init", "-q", "-b", "main"]);
	execFileSync("git", [
		"-C",
		shared,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"legacy init",
	]);
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "magi-safegit-"));
	shared = join(base, "shared");
	mkdirSync(shared);
	marker = join(base, "PWNED");
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("ensureSharedGitDir", () => {
	it("creates a daemon-owned git dir beside shared/ with an initial commit", async () => {
		ensureSharedGitDir(shared);
		expect(existsSync(sharedGitDir(shared))).toBe(true);
		expect(existsSync(join(shared, ".git"))).toBe(false);
		const { stdout } = await runGit(shared, ["log", "--oneline"]);
		expect(stdout).toContain("initialise mission workspace");
	});

	it("migrates a legacy shared/.git and keeps its history", async () => {
		legacyRepo();
		ensureSharedGitDir(shared);
		expect(existsSync(join(shared, ".git"))).toBe(false);
		const { stdout } = await runGit(shared, ["log", "--oneline"]);
		expect(stdout).toContain("legacy init");
	});

	it("is idempotent across boots", () => {
		ensureSharedGitDir(shared);
		expect(() => ensureSharedGitDir(shared)).not.toThrow();
	});

	it("discards a legacy git dir containing a planted symlink instead of migrating it", async () => {
		legacyRepo();
		symlinkSync(base, join(shared, ".git", "evil-link"));
		ensureSharedGitDir(shared);
		const { stdout } = await runGit(shared, ["log", "--oneline"]);
		expect(stdout).not.toContain("legacy init");
		expect(stdout).toContain("initialise mission workspace");
	});
});

describe("GIT1: agent-planted git programs never execute", () => {
	it("ignores a pre-commit hook planted in the legacy shared/.git", async () => {
		legacyRepo();
		const hook = join(shared, ".git", "hooks", "pre-commit");
		writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
		chmodSync(hook, 0o755);
		ensureSharedGitDir(shared);

		writeFileSync(join(shared, "a.txt"), "x");
		expect(await new WorkspaceGit(shared).commit("turn")).not.toBeNull();
		expect(existsSync(marker)).toBe(false);
	});

	it("ignores core.fsmonitor and a filter driver set in the legacy repo config", async () => {
		legacyRepo();
		const evil = evilScript("evil.sh");
		execFileSync("git", ["-C", shared, "config", "core.fsmonitor", evil]);
		execFileSync("git", ["-C", shared, "config", "filter.evil.clean", evil]);
		writeFileSync(join(shared, ".gitattributes"), "* filter=evil\n");
		ensureSharedGitDir(shared);

		writeFileSync(join(shared, "a.txt"), "x");
		expect(await new WorkspaceGit(shared).commit("turn")).not.toBeNull();
		expect(existsSync(marker)).toBe(false);
		expect(
			readFileSync(join(sharedGitDir(shared), "config"), "utf8"),
		).not.toContain("fsmonitor");
	});

	it("ignores a shared/.git an agent creates after migration", async () => {
		ensureSharedGitDir(shared);
		const fake = join(shared, ".git");
		mkdirSync(join(fake, "hooks"), { recursive: true });
		const evil = evilScript("evil.sh");
		writeFileSync(
			join(fake, "config"),
			`[core]\n\tfsmonitor = ${evil}\n\thooksPath = ${join(fake, "hooks")}\n`,
		);
		writeFileSync(
			join(fake, "hooks", "pre-commit"),
			`#!/bin/sh\ntouch ${marker}\n`,
		);
		chmodSync(join(fake, "hooks", "pre-commit"), 0o755);

		writeFileSync(join(shared, "a.txt"), "x");
		const r = await new WorkspaceGit(shared).commit("turn");
		expect(r?.changedFiles.map((c) => c.path)).toEqual(["a.txt"]);
		expect(existsSync(marker)).toBe(false);
	});

	it("ignores a global ~/.gitconfig fsmonitor (the CHAIN-A route via a planted HOME file)", async () => {
		const fakeHome = join(base, "home");
		mkdirSync(fakeHome);
		writeFileSync(
			join(fakeHome, ".gitconfig"),
			`[core]\n\tfsmonitor = ${evilScript("evil.sh")}\n`,
		);
		const savedHome = process.env.HOME;
		process.env.HOME = fakeHome;
		try {
			ensureSharedGitDir(shared);
			writeFileSync(join(shared, "a.txt"), "x");
			expect(await new WorkspaceGit(shared).commit("turn")).not.toBeNull();
		} finally {
			process.env.HOME = savedHome;
		}
		expect(existsSync(marker)).toBe(false);
	});
});

describe("hardenedGitEnv", () => {
	it("never forwards the daemon's secrets to git", () => {
		const saved = process.env.MONGODB_URI;
		process.env.MONGODB_URI = "mongodb+srv://secret";
		try {
			const env = hardenedGitEnv();
			expect(env.MONGODB_URI).toBeUndefined();
			expect(Object.keys(env).sort()).toEqual([
				"GIT_CONFIG_GLOBAL",
				"GIT_CONFIG_NOSYSTEM",
				"GIT_TERMINAL_PROMPT",
				"HOME",
				"PATH",
			]);
		} finally {
			if (saved === undefined) delete process.env.MONGODB_URI;
			else process.env.MONGODB_URI = saved;
		}
	});
});
