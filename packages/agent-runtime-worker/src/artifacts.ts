import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Artifact ID
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable, sortable artifact ID.
 * Format: {slug}-{YYYYMMDD}T{HHmmss}
 * The slug is derived from the URL hostname or the filename stem.
 *
 * Examples:
 *   "https://reuters.com/article/foo" → "reuters-com-20260223T143012"
 *   "/home/user/docs/report.pdf"      → "report-20260223T143012"
 */
export function generateArtifactId(sourceHint: string): string {
	const now = new Date();
	const ts =
		now.getFullYear().toString() +
		String(now.getMonth() + 1).padStart(2, "0") +
		String(now.getDate()).padStart(2, "0") +
		"T" +
		String(now.getHours()).padStart(2, "0") +
		String(now.getMinutes()).padStart(2, "0") +
		String(now.getSeconds()).padStart(2, "0");

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
	return `${slug}-${ts}`;
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

async function writeDirectory(
	dir: string,
	files: FileEntry[],
	meta: ArtifactMeta | UploadMeta,
): Promise<string> {
	await mkdir(dir, { recursive: true });
	for (const f of files) {
		if (typeof f.content === "string") {
			await writeFile(join(dir, f.name), f.content, "utf8");
		} else {
			await writeFile(join(dir, f.name), f.content);
		}
	}
	await writeFile(
		join(dir, "meta.json"),
		JSON.stringify(meta, null, 2),
		"utf8",
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
	return writeDirectory(join(artifactsDir, "artifacts", id), files, meta);
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
	return writeDirectory(join(workdir, "uploads", id), files, meta);
}
