/**
 * The Research tool's shared cache: one `<slug>.md` per finding plus an
 * `index.json`, under `shared/research/` so teammates reuse each other's
 * findings.
 */

import { randomBytes } from "node:crypto";
import { renameSync } from "node:fs";
import { join } from "node:path";
import {
	mkdirInside,
	PathNotFoundError,
	readInside,
	resolveInside,
	writeFileInside,
} from "../safe-path.js";

// ---------------------------------------------------------------------------
// Research index types
// ---------------------------------------------------------------------------

export interface ResearchEntry {
	slug: string;
	question: string;
	/** First 500 chars of the finding — full text in the .md file. */
	answer: string;
	sources: string[];
	savedAt: string;
	agentId: string;
}

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------

/*
 * The cache lives in shared/research, which every agent can write — including
 * index.json, whose slugs name the files the daemon then reads. Every access
 * therefore goes through safe-path relative to sharedDir (a symlinked
 * research/ is refused, a link at the final component is never followed) and
 * a slug must be a plain name, so a planted row cannot make this daemon-side
 * tool return /proc/self/environ or overwrite a file outside shared/.
 */
const RESEARCH_DIR = "research";
const INDEX_FILE = `${RESEARCH_DIR}/index.json`;
const SLUG_RE = /^[a-z0-9-]{1,80}$/;

function loadIndex(sharedDir: string): ResearchEntry[] {
	let raw: string;
	try {
		raw = readInside(sharedDir, INDEX_FILE, {
			maxBytes: 20 * 1024 * 1024,
		}).bytes.toString("utf-8");
	} catch (e) {
		if (e instanceof PathNotFoundError) return [];
		console.warn(
			`[research] index.json refused (${(e as Error).message}) — the cache is ignored`,
		);
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) throw new Error("not an array");
		return parsed as ResearchEntry[];
	} catch (e) {
		// RS3: the next save would overwrite a corrupt index with one entry,
		// losing every cached finding's index row; keep the bad file aside.
		const p = resolveInside(sharedDir, INDEX_FILE);
		const aside = `${p}.corrupt-${Date.now()}`;
		try {
			renameSync(p, aside);
		} catch {
			// Already moved by a concurrent reader; nothing left to keep.
		}
		console.warn(
			`[research] index.json was unreadable (${(e as Error).message}) — moved to ${aside}, starting a new index`,
		);
		return [];
	}
}

function normalise(q: string): string {
	return q.toLowerCase().trim().replace(/\s+/g, " ");
}

function findCached(
	index: ResearchEntry[],
	question: string,
	maxAgeHours: number,
): ResearchEntry | undefined {
	const key = normalise(question);
	const cutoff = Date.now() - maxAgeHours * 3_600_000;
	return index.find(
		(e) =>
			normalise(e.question) === key && new Date(e.savedAt).getTime() >= cutoff,
	);
}

export function slugify(question: string): string {
	return (
		question
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 60) +
		"-" +
		Date.now().toString(36)
	);
}

export function saveEntry(
	sharedDir: string,
	entry: ResearchEntry,
	fullAnswer: string,
): void {
	mkdirInside(sharedDir, RESEARCH_DIR, { exclusive: false });

	// Write full finding to its own .md file. Exclusive: the slug ends in a
	// timestamp, so an existing file at that name was planted.
	const header = [
		`# Research: ${entry.question}`,
		``,
		`**Agent:** ${entry.agentId}  **Date:** ${entry.savedAt}`,
		`**Sources:** ${entry.sources.join(", ") || "(none recorded)"}`,
		``,
		`---`,
		``,
	].join("\n");
	writeFileInside(
		sharedDir,
		`${RESEARCH_DIR}/${entry.slug}.md`,
		header + fullAnswer,
		{ exclusive: true },
	);

	// Append to index: read-modify-write, written to a temp file and renamed
	// so a reader never sees a half-written index. Two Research calls saving
	// at the same moment (agent + Tool API) can still lose one row; the .md
	// finding itself is never lost (RS3). The temp name is unpredictable and
	// created exclusively; rename replaces a planted index.json link itself,
	// never its target.
	const index = loadIndex(sharedDir);
	index.push(entry);
	const tmp = writeFileInside(
		sharedDir,
		`${INDEX_FILE}.${randomBytes(8).toString("hex")}.tmp`,
		JSON.stringify(index, null, 2),
		{ exclusive: true },
	);
	renameSync(tmp, join(resolveInside(sharedDir, RESEARCH_DIR), "index.json"));
}

/** A cached finding young enough to reuse: its header line and full text (from the .md file when present). */
export function readCachedFinding(
	sharedDir: string,
	question: string,
	maxAge: number,
): { header: string; answer: string } | null {
	const cached = findCached(loadIndex(sharedDir), question, maxAge);
	if (!cached) return null;
	let answer = cached.answer;
	if (typeof cached.slug === "string" && SLUG_RE.test(cached.slug)) {
		try {
			const raw = readInside(
				sharedDir,
				`${RESEARCH_DIR}/${cached.slug}.md`,
			).bytes.toString("utf-8");
			const sep = raw.indexOf("\n---\n");
			answer = sep !== -1 ? raw.slice(sep + 5).trim() : raw.trim();
		} catch {
			// Missing or refused (a symlink): fall back to the index's answer.
		}
	}
	return {
		header: `[Cached finding — ${cached.agentId}, ${new Date(cached.savedAt).toISOString().slice(0, 16)}]`,
		answer,
	};
}
