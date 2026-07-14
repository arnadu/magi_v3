/**
 * Supervisor note — a daemon-managed `#supervisor-note` mental-map region,
 * written by the mission copilot's EditAgentMentalMap tool (ADR-0016) and
 * rendered fresh into the target agent's mental map at the start of every
 * turn — the exact same lazy-render pattern `#my-objectives` already uses
 * (see objectives/agent-view.ts).
 *
 * File-based under sharedDir, not Mongo: agent-runner.ts has no MongoDB
 * access today (it's fully repository-injected and DB-agnostic, matching its
 * "no MongoDB" unit-testability) — a file mirrors the objectives store's own
 * convention (sharedDir/objectives/) rather than adding a new db dependency
 * for one small feature.
 *
 * Deliberately not a stored HTML patch: the mental map is a per-turn HTML
 * *snapshot* (embedded in each turn's own conversationMessages document),
 * not a document another process can safely patch out of band — writing a
 * synthetic conversationMessages entry to carry a mental-map-only update
 * would risk polluting the target agent's own LLM conversation history.
 * Lazy re-render from a small side file avoids that entirely.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The `data-managed` key for this region — no `id`, so the target agent's own id-only mental-map tools cannot reach or spoof it. */
export const SUPERVISOR_NOTE_KEY = "supervisor-note";

export interface SupervisorNote {
	note: string;
	by: string;
	/** ISO timestamp. */
	at: string;
}

function notePath(sharedDir: string, agentId: string): string {
	return join(sharedDir, "supervisor-notes", `${agentId}.json`);
}

/** Overwrite the current note for one agent (one note per agent — the latest replaces, not appends). */
export async function writeSupervisorNote(
	sharedDir: string,
	agentId: string,
	note: string,
	by: string,
): Promise<void> {
	const dir = join(sharedDir, "supervisor-notes");
	await mkdir(dir, { recursive: true });
	const entry: SupervisorNote = { note, by, at: new Date().toISOString() };
	await writeFile(
		notePath(sharedDir, agentId),
		JSON.stringify(entry, null, 2),
		"utf8",
	);
}

/** Read the current note for one agent, or null if none exists (or the file is invalid — never breaks the caller's turn). */
export async function readSupervisorNote(
	sharedDir: string,
	agentId: string,
): Promise<SupervisorNote | null> {
	try {
		const raw = await readFile(notePath(sharedDir, agentId), "utf8");
		const parsed = JSON.parse(raw) as SupervisorNote;
		if (typeof parsed.note !== "string" || typeof parsed.by !== "string") {
			return null;
		}
		return parsed;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(
				`[supervisor-note] ignoring invalid note file for ${agentId}: ${(e as Error).message}`,
			);
		}
		return null;
	}
}

function esc(s: string): string {
	return s.replace(
		/[&<>]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string,
	);
}

/** Build the inner HTML for the agent's `#supervisor-note` section. */
export function renderSupervisorNote(entry: SupervisorNote): string {
	return [
		"<h3>Note from your supervisor</h3>",
		`<p><em>From ${esc(entry.by)}, ${entry.at}</em></p>`,
		`<p>${esc(entry.note)}</p>`,
	].join("\n");
}
