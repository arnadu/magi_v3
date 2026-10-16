import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { mkdirInside, writeFileInside } from "./safe-path.js";

// ---------------------------------------------------------------------------
// Artifact ID
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable, sortable artifact ID.
 * Format: {slug}-{YYYYMMDD}T{HHmmss}Z-{4 hex}
 * The slug is derived from the URL hostname or the filename stem; the
 * timestamp is UTC; the random suffix exists because the directory is
 * created by the daemon inside agent-writable `shared/` — an id an agent can
 * predict is a directory it can pre-plant (as a symlink elsewhere) and have
 * the daemon write fetched web content into. It also stops two artifacts
 * from the same host in the same second from colliding.
 *
 * Examples:
 *   "https://reuters.com/article/foo" → "reuters-com-20260223T143012Z-9f3a"
 *   "/home/user/docs/report.pdf"      → "report-20260223T143012Z-0c71"
 */
export function generateArtifactId(sourceHint: string): string {
	const ts = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
	const suffix = randomBytes(2).toString("hex");

	let slug: string;
	try {
		const url = new URL(sourceHint);
		slug = url.hostname
			.toLowerCase()
			.replace(/\./g, "-")
			.replace(/[^a-z0-9-]/g, "")
			.replace(/^-+|-+$/g, "")
			.slice(0, 50);
	} catch {
		// Not a URL — derive slug from filename stem
		slug = (sourceHint.replace(/\\/g, "/").split("/").pop() ?? "file")
			.replace(/\.[^.]*$/, "") // strip extension
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 50);
	}

	if (!slug) slug = "file";
	return `${slug}-${ts}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Schema types (Schema.org-inspired)
// ---------------------------------------------------------------------------

export interface ArtifactMeta {
	"@type": string; // e.g. "Article", "DigitalDocument"
	id: string;
	name: string; // page title or filename
	url?: string; // source URL or "file://" URI
	dateCreated: string; // ISO 8601
	encodingFormat?: string; // original MIME type
	description?: string;
	author?: string;
	images?: string[]; // relative paths to downloaded images inside the artifact dir
	[key: string]: unknown;
}

export interface UploadMeta {
	"@type": "UploadedFile";
	id: string;
	name: string; // original filename
	dateCreated: string;
	encodingFormat?: string;
	size?: number; // bytes
}

// ---------------------------------------------------------------------------
// File entry — used for both artifacts and uploads
// ---------------------------------------------------------------------------

export interface FileEntry {
	/** Filename within the artifact / upload directory (e.g. "content.md", "image-0.jpg"). */
	name: string;
	content: string | Buffer;
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * A file name inside an artifact directory: one component, never `.`/`..`/
 * empty. Names come from processors (content.md, image-0.jpg) and from ZIP
 * entries and sheet titles, which are attacker-influenced — a bad one is
 * replaced, not written somewhere else and not allowed to abort the archive.
 */
export function safeEntryName(name: string): string {
	const base = basename(name.replace(/\0/g, ""));
	if (base === "" || base === "." || base === "..") return "file";
	return base;
}

/**
 * Create `relDir` under `root` and write `files` + `meta.json` into it. The
 * directory is created exclusively (a pre-planted directory or symlink at
 * that path fails instead of being reused), every parent is realpath'd and
 * every file is opened `O_EXCL|O_NOFOLLOW`, so a symlink an agent plants in
 * the tree cannot redirect what the daemon writes — the agent-writable
 * `shared/` tree is exactly where these land (safe-path.ts).
 */
async function writeDirectory(
	root: string,
	relDir: string,
	files: FileEntry[],
	meta: ArtifactMeta | UploadMeta,
): Promise<string> {
	const dir = mkdirInside(root, relDir);
	const seen = new Set<string>();
	for (const f of files) {
		let name = safeEntryName(f.name);
		if (name === "meta.json") name = "meta.1.json";
		// Two entries that sanitise to the same name must not clobber each other.
		for (let n = 1; seen.has(name); n++) name = `${n}-${safeEntryName(f.name)}`;
		seen.add(name);
		writeFileInside(root, join(relDir, name), f.content, {
			exclusive: true,
			mkdirParents: false,
		});
	}
	writeFileInside(
		root,
		join(relDir, "meta.json"),
		JSON.stringify(meta, null, 2),
		{
			exclusive: true,
			mkdirParents: false,
		},
	);
	return dir;
}

// ---------------------------------------------------------------------------
// saveArtifact
// ---------------------------------------------------------------------------

/**
 * Write `files` + `meta.json` under `{artifactsDir}/artifacts/{id}/`.
 * Returns the absolute path to the artifact directory.
 *
 * `artifactsDir` is always the mission's `sharedDir` at every current call
 * site (document-processor.ts, fetch-url.ts, browse-web.ts) — named for what
 * it is, not "workdir": an agent's Bash tool runs with cwd set to its own
 * private workdir, not sharedDir, so a bare relative `artifacts/<id>/...`
 * path silently resolves nowhere for the agent (issue #51). Generated
 * content.md text that points back at an artifact must account for this —
 * see inspectImageHint() in document-processor.ts and the `$SHARED_DIR`
 * env var (injected into every Bash subprocess, tools.ts) for the two ways
 * that's actually done.
 *
 * Convention: pass `{ name: "content.md", content: markdownText }` as the
 * primary file. Additional files (extracted images, raw data) can follow.
 */
export async function saveArtifact(
	artifactsDir: string,
	id: string,
	files: FileEntry[],
	meta: ArtifactMeta,
): Promise<string> {
	return writeDirectory(artifactsDir, join("artifacts", id), files, meta);
}

// ---------------------------------------------------------------------------
// saveUpload
// ---------------------------------------------------------------------------

/**
 * Write `files` + `meta.json` under `{workdir}/uploads/{id}/`.
 * Returns the absolute path to the upload directory.
 *
 * The upload directory follows the same layout as an artifact directory so
 * agents can read either with the same `cat uploads/<id>/content.md` pattern.
 * Binary files (PDFs, images) are stored under their original filename.
 */
export async function saveUpload(
	workdir: string,
	id: string,
	files: FileEntry[],
	meta: UploadMeta,
): Promise<string> {
	return writeDirectory(workdir, join("uploads", id), files, meta);
}
