import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSharedGitDir, runGit } from "../src/safe-git.js";
import { WorkspaceGit } from "../src/workspace-git.js";

// Real git against a throwaway repo — deterministic, no network, no LLM.
// Uses the production layout (GIT1, 2026-10-15 audit): the git dir is a
// daemon-owned `shared.git` beside `shared/`, never `shared/.git`.

let base: string;
let dir: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "magi-wsgit-"));
	dir = join(base, "shared");
	mkdirSync(dir);
	ensureSharedGitDir(dir);
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("WorkspaceGit", () => {
	it("commits new + modified files and reports changed paths with status", async () => {
		writeFileSync(join(dir, "a.txt"), "hello");
		writeFileSync(join(dir, "b.md"), "# title");
		const wg = new WorkspaceGit(dir);

		const r = await wg.commit("turn: agent/0");
		expect(r).not.toBeNull();
		expect(r?.commit).toMatch(/^[0-9a-f]{40}$/);
		const paths = (r?.changedFiles ?? []).map((c) => c.path).sort();
		expect(paths).toEqual(["a.txt", "b.md"]);
		expect(r?.changedFiles.every((c) => c.status === "A")).toBe(true);

		// The content is retrievable at that commit (the file-viewer access path).
		const { stdout: shown } = await runGit(dir, ["show", `${r?.commit}:a.txt`]);
		expect(shown).toBe("hello");
	});

	it("returns null when there is nothing to commit (no empty commits)", async () => {
		const wg = new WorkspaceGit(dir);
		expect(await wg.commit("turn: agent/0")).toBeNull();
	});

	it("captures a Bash-style file the tool interface never sees", async () => {
		// Simulate a file written by a shell command (not WriteFile/EditFile).
		execFileSync("bash", ["-c", `echo data > ${join(dir, "out.csv")}`]);
		const wg = new WorkspaceGit(dir);
		const r = await wg.commit("turn: agent/1");
		expect(r?.changedFiles.map((c) => c.path)).toEqual(["out.csv"]);
	});

	it("serializes concurrent commits without git-lock collisions", async () => {
		const wg = new WorkspaceGit(dir);
		// Fire several commits concurrently; each writes a distinct file first.
		const results = await Promise.all(
			[0, 1, 2, 3, 4].map(async (i) => {
				writeFileSync(join(dir, `f${i}.txt`), `v${i}`);
				return wg.commit(`turn: agent/${i}`);
			}),
		);
		// Every call resolves (no thrown lock error). Because writes race the
		// serialized commits, the exact split varies, but the total set of files
		// committed across all non-null results must equal all five.
		const committed = new Set<string>();
		for (const r of results) {
			for (const c of r?.changedFiles ?? []) committed.add(c.path);
		}
		expect([...committed].sort()).toEqual([
			"f0.txt",
			"f1.txt",
			"f2.txt",
			"f3.txt",
			"f4.txt",
		]);
		// HEAD history is linear and intact (no corruption from concurrent access).
		const { stdout: log } = await runGit(dir, ["log", "--oneline"]);
		expect(log.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(2);
	});

	it("does not throw when the workspace has no git dir (logged, returns null)", async () => {
		const nonRepoBase = mkdtempSync(join(tmpdir(), "magi-nonrepo-"));
		const nonRepo = join(nonRepoBase, "shared");
		mkdirSync(nonRepo);
		try {
			const wg = new WorkspaceGit(nonRepo);
			writeFileSync(join(nonRepo, "x.txt"), "y");
			expect(await wg.commit("turn: agent/0")).toBeNull();
		} finally {
			rmSync(nonRepoBase, { recursive: true, force: true });
		}
	});
});
