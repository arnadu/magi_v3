/**
 * The platform's own prompts — the text MAGI itself writes to a model, as
 * opposed to a team's agent prompts, which live in its config YAML. Each is a
 * file in packages/agent-runtime-worker/prompts/, so prose is edited and
 * reviewed apart from code.
 *
 * Resolved relative to this module: src/ (tests) and dist/ (production) both
 * sit one level below the package root, so "../prompts/" is the same folder
 * from either. Both Docker images ship it (see .dockerignore and the
 * Dockerfiles); a missing file fails at first load, not silently.
 */

import { readFileSync } from "node:fs";

const PROMPTS_DIR = new URL("../prompts/", import.meta.url);

export type PromptFile =
	| "browse-agent.md"
	| "image-describe.md"
	| "image-ocr.md"
	| "image-page-visual.md"
	| "mental-map-pointer.md"
	| "mission-copilot-mental-map.html"
	| "mission-copilot.md"
	| "reflection.md"
	| "rendering-note.md"
	| "research-context-only.md"
	| "research.md";

// Prompt files are immutable for the life of the process (they ship in the
// image), so one read each is enough.
const cache = new Map<PromptFile, string>();

function readPrompt(file: PromptFile): string {
	let text = cache.get(file);
	if (text === undefined) {
		// Files end with a newline by convention; it is not part of the prompt.
		text = readFileSync(new URL(file, PROMPTS_DIR), "utf8").replace(/\n$/, "");
		cache.set(file, text);
	}
	return text;
}

/**
 * A prompt with its `{{name}}` placeholders filled from `vars`, in one pass:
 * a value is never re-scanned, so text from a config (a roster line, a
 * mission name) that contains `{{...}}` is inserted literally. Placeholders
 * not in `vars` are left as they are — some prompts carry ones that are
 * filled later (`{{mentalMap}}`, `{{sharedDir}}` and `{{workdir}}` are
 * substituted per session by buildSystemPrompt). A var the file never uses
 * is an error: it means the file and the caller have drifted apart.
 */
export function loadPrompt(
	file: PromptFile,
	vars: Record<string, string | number> = {},
): string {
	const text = readPrompt(file);
	const unused = Object.keys(vars).filter((k) => !text.includes(`{{${k}}}`));
	if (unused.length > 0) {
		throw new Error(
			`Prompt ${file} has no placeholder for ${unused.map((k) => `{{${k}}}`).join(", ")}`,
		);
	}
	return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
		Object.hasOwn(vars, name) ? String(vars[name]) : match,
	);
}
