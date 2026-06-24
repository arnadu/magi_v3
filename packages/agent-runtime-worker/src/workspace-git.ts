/**
 * Workspace git checkpointing — Sprint 25.
 *
 * The daemon commits the shared mission workspace at the end of each agent turn
 * (see agent-runner's onTurnEnd path). This gives every work product a
 * provenance trail and captures files written by ANY tool — including Bash and
 * skill scripts, which the tool-call interface cannot see (only WriteFile/
 * EditFile expose their paths). The resulting commit hash is stored on the turn
 * stats (`agentTurnStats.gitCommit`) so the file viewer can later retrieve any
 * version via `git show <hash>:<relPath>`.
 *
 * Concurrency: multiple agents may finish turns at overlapping times, and two
 * concurrent `git add`/`commit` invocations would collide on `.git/index.lock`.
 * All operations are therefore serialized through a single in-process promise
 * chain (one WorkspaceGit instance per mission). A commit reflects the workspace
 * delta since the previous commit — i.e. it may include changes from other
 * agents in flight; it is a workspace checkpoint, not a per-agent slice.
 *
 * Agents no longer commit their own work — the git-provenance skill is updated
 * accordingly. Failures are logged and swallowed: git tracking must never break
 * a mission.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/** One file changed in a commit, with its git status letter (A/M/D/R…). */
export interface ChangedFile {
	path: string;
	status: string;
}

export interface CommitResult {
	/** Full commit SHA. */
	commit: string;
	changedFiles: ChangedFile[];
}

export class WorkspaceGit {
	/** Serializes all git operations to avoid `.git/index.lock` collisions. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly sharedDir: string) {}

	/** Run `fn` after all previously-queued git operations complete. */
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn);
		// Keep the chain alive regardless of this operation's outcome.
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private git(...args: string[]): Promise<{ stdout: string }> {
		return pexec("git", ["-C", this.sharedDir, ...args]);
	}

	/**
	 * Stage everything and commit. Returns the new commit + its changed files, or
	 * null when there is nothing to commit (no empty commits are created) or on
	 * any git failure (logged). Serialized against concurrent callers.
	 */
	commit(message: string): Promise<CommitResult | null> {
		return this.serialize(async () => {
			try {
				await this.git("add", "-A");
				// Nothing staged → skip (avoids empty-commit bloat).
				const { stdout: status } = await this.git("status", "--porcelain");
				if (!status.trim()) return null;

				await this.git(
					"-c",
					"user.name=magi",
					"-c",
					"user.email=magi@magi",
					"commit",
					"-m",
					message,
				);

				const { stdout: hash } = await this.git("rev-parse", "HEAD");
				const commit = hash.trim();

				// Name + status of every path in this commit.
				const { stdout: diff } = await this.git(
					"diff-tree",
					"--no-commit-id",
					"--name-status",
					"-r",
					commit,
				);
				const changedFiles: ChangedFile[] = diff
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean)
					.map((line) => {
						const tab = line.indexOf("\t");
						return {
							status: line.slice(0, tab),
							path: line.slice(tab + 1),
						};
					});

				return { commit, changedFiles };
			} catch (e) {
				console.error(
					`[workspace-git] commit failed in ${this.sharedDir}: ${(e as Error).message}`,
				);
				return null;
			}
		});
	}
}
