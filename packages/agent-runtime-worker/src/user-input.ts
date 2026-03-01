/**
 * user-input.ts — preprocessing for user-typed input in the REPL and CLI.
 *
 * Two features:
 *
 *   @path syntax  — `@/abs/path` or `@./rel/path` tokens are expanded:
 *                   the file is read, saved to uploads/, and the token is
 *                   replaced with a notice that agents can act on.
 *
 *   /command      — lines starting with `/` are intercepted as built-in
 *                   CLI commands rather than messages to the agent.
 *                   Currently supported: /help
 */

import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
	generateArtifactId,
	saveUpload,
	type UploadMeta,
} from "./artifacts.js";

// ---------------------------------------------------------------------------
// /command handling
// ---------------------------------------------------------------------------

const HELP_TEXT = `
MAGI REPL commands (start with /):
  /help    Show this help message

@path shortcuts:
  @/abs/path         Upload a file at an absolute path
  @./relative/path   Upload a file relative to the current directory

Examples:
  Summarise this document @./report.pdf
  @/home/user/data.csv Analyse this dataset
`.trim();

/**
 * Handle a `/command` line. Returns true if the line was a command (caller
 * should NOT post it to the mailbox), false if it was not a command.
 */
export function handleCommand(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.startsWith("/")) return false;

	const [cmd] = trimmed.split(/\s+/);
	switch (cmd) {
		case "/help":
			console.log(`\n${HELP_TEXT}\n`);
			return true;
		default:
			console.log(
				`Unknown command: ${cmd}. Type /help for available commands.`,
			);
			return true;
	}
}

// ---------------------------------------------------------------------------
// @path expansion
// ---------------------------------------------------------------------------

/** Pattern: @/abs/path or @./rel/path (no surrounding quotes required). */
const AT_PATH_RE = /@((?:\.\/|\/)[^\s]+)/g;

/**
 * Detect if a line contains any @path tokens.
 * Fast check before doing async work.
 */
export function hasAtPaths(line: string): boolean {
	AT_PATH_RE.lastIndex = 0;
	return AT_PATH_RE.test(line);
}

/**
 * Expand @path tokens in `line`:
 *   1. Read the file at the path (resolved relative to `cwd`).
 *   2. Save it to `{workdir}/uploads/<id>/`.
 *   3. Replace the `@path` token with a structured notice for agents.
 *
 * Returns the expanded string, or the original string if no @path tokens
 * are present. Per-token errors are non-fatal; the error is inlined as a
 * notice so the agent can see what failed.
 */
export async function expandAtPaths(
	line: string,
	workdir: string,
	cwd = process.cwd(),
): Promise<string> {
	// Collect all @path matches first (avoid re-running regex on modified string)
	const matches: Array<{ token: string; rawPath: string }> = [];
	for (const m of line.matchAll(AT_PATH_RE)) {
		matches.push({ token: m[0], rawPath: m[1] });
	}

	if (matches.length === 0) return line;

	let result = line;
	for (const { token, rawPath } of matches) {
		const absPath = resolve(cwd, rawPath);
		let notice: string;

		try {
			const info = await stat(absPath);
			if (info.size > 500 * 1024 * 1024) {
				notice = `[Upload failed for "${rawPath}": file too large (${info.size} bytes, limit 500 MB)]`;
				result = result.replace(token, notice);
				continue;
			}
			const bytes = await readFile(absPath);
			const name = basename(absPath);
			const ext = name.split(".").pop()?.toLowerCase() ?? "";

			// Guess MIME type from extension
			const mimeMap: Record<string, string> = {
				pdf: "application/pdf",
				png: "image/png",
				jpg: "image/jpeg",
				jpeg: "image/jpeg",
				gif: "image/gif",
				webp: "image/webp",
				txt: "text/plain",
				md: "text/markdown",
				html: "text/html",
				htm: "text/html",
				csv: "text/csv",
				json: "application/json",
			};
			const mimeType = mimeMap[ext] ?? "application/octet-stream";

			const uploadId = generateArtifactId(name);
			const meta: UploadMeta = {
				"@type": "UploadedFile",
				id: uploadId,
				name,
				dateCreated: new Date().toISOString(),
				encodingFormat: mimeType,
				size: info.size,
			};

			await saveUpload(workdir, uploadId, [{ name, content: bytes }], meta);

			notice = `[Uploaded: uploads/${uploadId}/ — ${name} (${info.size} bytes, ${mimeType})]`;
		} catch (e) {
			notice = `[Upload failed for "${rawPath}": ${(e as Error).message}]`;
		}

		result = result.replace(token, notice);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Process a raw line of user input from the REPL or CLI.
 *
 * Returns:
 *   - `undefined`  — line was a /command (already handled; do not post)
 *   - `string`     — the body to post to the agent mailbox (may be unchanged
 *                    or have @path tokens expanded into upload notices)
 */
export async function processUserInput(
	line: string,
	workdir: string,
): Promise<string | undefined> {
	const trimmed = line.trim();
	if (!trimmed) return undefined;

	// /command takes priority over @path
	if (handleCommand(trimmed)) return undefined;

	// Expand @path tokens
	return expandAtPaths(trimmed, workdir);
}
