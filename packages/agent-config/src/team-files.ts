import { isAbsolute, normalize, sep } from "node:path";

export interface TeamFileInput {
	path: string;
	content: string;
}

/**
 * Caps chosen to be generous for real skill/script attachments while
 * bounding the worst case: a tenant/agent supplying thousands of files or
 * multi-megabyte blobs that get written to the daemon's filesystem on
 * every boot (team-files-sync.ts).
 */
export const MAX_TEAM_FILES = 500;
export const MAX_TEAM_FILE_BYTES = 1_000_000;

/**
 * TF1/CHAIN-A (2026-10-15 audit): validates one team-file's relative path.
 * `teamFiles` is written by five independent callers — three control-plane
 * REST routes, the mission-copilot's `SaveMissionConfig` tool, and the
 * control-plane copilot's `save_session_config` action — and then written
 * to disk unvalidated on every mission boot (`daemon-boot/team-files-sync.ts`,
 * `join(teamDir, relPath)`). An absolute path or a `..` segment let any of
 * those callers write anywhere the daemon identity can write, including its
 * own `~/.gitconfig` (which `workspace-git.ts`'s unhardened git calls would
 * then execute — GIT1/CHAIN-A). Every writer must call this (or
 * `validateTeamFiles` for a whole array) before the path is persisted or
 * used; `team-files-sync.ts` also re-checks at write time as defense in
 * depth, since a shared validator one caller forgets to use is still a hole.
 */
export function validateTeamFilePath(relPath: string): void {
	if (typeof relPath !== "string" || relPath.length === 0) {
		throw new Error("teamFiles path must be a non-empty string");
	}
	if (relPath.includes("\0")) {
		throw new Error(
			`teamFiles path contains a NUL byte: ${JSON.stringify(relPath)}`,
		);
	}
	if (isAbsolute(relPath)) {
		throw new Error(
			`teamFiles path must be relative, not absolute: "${relPath}"`,
		);
	}
	// normalize() cannot cancel a ".." that has nothing earlier in the path
	// to collapse against, so any surviving ".." segment after normalizing
	// means the path tries to climb above its own base directory.
	const normalized = normalize(relPath);
	if (normalized.split(sep).includes("..")) {
		throw new Error(
			`teamFiles path must not escape its directory: "${relPath}"`,
		);
	}
}

/** Validates a whole `teamFiles` array: count cap, per-file size cap, and every path. */
export function validateTeamFiles(files: TeamFileInput[]): void {
	if (files.length > MAX_TEAM_FILES) {
		throw new Error(
			`teamFiles: too many files (${files.length} > ${MAX_TEAM_FILES})`,
		);
	}
	for (const f of files) {
		validateTeamFilePath(f.path);
		if (typeof f.content !== "string") {
			throw new Error(`teamFiles: content for "${f.path}" must be a string`);
		}
		if (Buffer.byteLength(f.content, "utf8") > MAX_TEAM_FILE_BYTES) {
			throw new Error(
				`teamFiles: "${f.path}" exceeds the ${MAX_TEAM_FILE_BYTES}-byte cap`,
			);
		}
	}
}
