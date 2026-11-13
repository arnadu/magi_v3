/**
 * One CreateImage job's folder, `shared/images/<job-id>/` (ADR-0035 decision
 * 6): `candidate-N.<ext>`, `manifest.json` and `contact-sheet.html`.
 *
 * `shared/` is writable by every agent, and the daemon writes here, so the
 * job directory is created exclusively (a planted directory or symlink fails
 * instead of being reused), candidates are created `O_EXCL|O_NOFOLLOW`, and
 * the manifest and contact sheet are rewritten without following a link
 * (safe-path.ts). The id carries 64 random bits: another agent cannot
 * pre-plant the folder of a job not yet started.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdirInside, readInside, writeFileInside } from "../safe-path.js";

export const IMAGES_DIR = "images";
export const JOB_ID_RE = /^img-\d{8}-[0-9a-f]{16}$/;
const MANIFEST = "manifest.json";
const CONTACT_SHEET = "contact-sheet.html";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 16 * 1024 * 1024;
/** A raster original embedded in the contact sheet when no preview could be made. */
const MAX_EMBEDDED_ORIGINAL_BYTES = 2 * 1024 * 1024;
/**
 * Base64 the contact sheet may embed in all: the Files panel opens HTML up
 * to 10 MB (TEXT_FILE_MAX_BYTES); candidates past the budget are named, not shown.
 */
export const CONTACT_SHEET_EMBED_BUDGET = 6 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/svg+xml": "svg",
};
const MIME_BY_EXT = Object.fromEntries(
	Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]),
);

export type JobStatus = "running" | "complete" | "partial" | "failed";

export interface CandidateRecord {
	n: number;
	file: string;
	mimeType: string;
	bytes: number;
	model: string;
	prompt: string;
	rationale?: string;
	/** Reference labels passed to the model (ref-1, candidate-2, parent). */
	references: string[];
	aspectRatio?: string;
	costUsd: number;
	costEstimated: boolean;
	responseId?: string;
	createdAt: string;
	/** The sub-agent's closing note on this candidate. */
	note?: string;
}

export interface CritiqueRecord {
	candidates: number[];
	text: string;
	costUsd: number;
	createdAt: string;
}

export interface JobManifest {
	version: 1;
	jobId: string;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
	brief: string;
	options: number;
	kind?: string;
	aspectRatio?: string;
	budget: { maxImages: number; maxUsd: number };
	parent?: { jobId: string; candidate: number };
	status: JobStatus;
	statusDetail?: string;
	candidates: CandidateRecord[];
	critiques: CritiqueRecord[];
	summary?: string;
	recommended?: number[];
	totals: {
		images: number;
		imageUsd: number;
		/** The sub-agent's own LLM calls (prompt writing, critique). */
		agentUsd: number;
		totalUsd: number;
		/** True when any image was charged at its menu ceiling price. */
		estimated: boolean;
	};
}

export function newJobId(now = new Date()): string {
	const day = now.toISOString().slice(0, 10).replaceAll("-", "");
	return `img-${day}-${randomBytes(8).toString("hex")}`;
}

const HTML_ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** Escapes the five HTML-significant characters, in one pass. */
export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export interface NewJob {
	createdBy: string;
	brief: string;
	options: number;
	kind?: string;
	aspectRatio?: string;
	budget: { maxImages: number; maxUsd: number };
	parent?: { jobId: string; candidate: number };
}

export class ImageJob {
	readonly manifest: JobManifest;
	/** Relative to the shared dir: `images/<job-id>`. */
	readonly relDir: string;
	/** Absolute, physical path of the job folder. */
	readonly dir: string;

	private constructor(
		private readonly sharedDir: string,
		manifest: JobManifest,
		dir: string,
	) {
		this.manifest = manifest;
		this.relDir = join(IMAGES_DIR, manifest.jobId);
		this.dir = dir;
	}

	/** Creates the job folder (exclusively) and its first manifest. */
	static create(sharedDir: string, init: NewJob, jobId = newJobId()): ImageJob {
		if (!JOB_ID_RE.test(jobId))
			throw new Error(`Invalid image job id ${jobId}`);
		mkdirInside(sharedDir, IMAGES_DIR, { exclusive: false });
		const dir = mkdirInside(sharedDir, join(IMAGES_DIR, jobId));
		const now = new Date().toISOString();
		const job = new ImageJob(
			sharedDir,
			{
				version: 1,
				jobId,
				createdAt: now,
				updatedAt: now,
				status: "running",
				candidates: [],
				critiques: [],
				totals: {
					images: 0,
					imageUsd: 0,
					agentUsd: 0,
					totalUsd: 0,
					estimated: false,
				},
				...init,
			},
			dir,
		);
		job.save();
		return job;
	}

	path(file: string): string {
		return join(this.dir, file);
	}

	/** Writes a new candidate file and records it; returns its record. */
	addCandidate(
		image: { mimeType: string; bytes: Buffer },
		meta: Omit<
			CandidateRecord,
			"n" | "file" | "mimeType" | "bytes" | "createdAt"
		>,
	): CandidateRecord {
		const ext = EXT_BY_MIME[image.mimeType];
		if (!ext) throw new Error(`No file type for ${image.mimeType}`);
		const n = this.manifest.candidates.length + 1;
		const file = `candidate-${n}.${ext}`;
		writeFileInside(this.sharedDir, join(this.relDir, file), image.bytes, {
			exclusive: true,
			mkdirParents: false,
		});
		const record: CandidateRecord = {
			n,
			file,
			mimeType: image.mimeType,
			bytes: image.bytes.length,
			createdAt: new Date().toISOString(),
			...meta,
		};
		this.manifest.candidates.push(record);
		const t = this.manifest.totals;
		t.images++;
		t.imageUsd += meta.costUsd;
		t.totalUsd += meta.costUsd;
		t.estimated ||= meta.costEstimated;
		this.save();
		return record;
	}

	addAgentCost(usd: number): void {
		this.manifest.totals.agentUsd += usd;
		this.manifest.totals.totalUsd += usd;
	}

	addCritique(record: Omit<CritiqueRecord, "createdAt">): void {
		this.manifest.critiques.push({
			...record,
			createdAt: new Date().toISOString(),
		});
		this.save();
	}

	/** Rewrites manifest.json (never through a link). */
	save(): void {
		this.manifest.updatedAt = new Date().toISOString();
		writeFileInside(
			this.sharedDir,
			join(this.relDir, MANIFEST),
			`${JSON.stringify(this.manifest, null, 2)}\n`,
			{ mkdirParents: false },
		);
	}

	/** Reads back a candidate this job wrote. */
	readCandidate(n: number): { mimeType: string; bytes: Buffer } {
		return readJobCandidate(this.sharedDir, this.manifest, n);
	}

	/** Writes contact-sheet.html; returns its relative path. */
	writeContactSheet(previews: ReadonlyMap<number, Buffer>): string {
		const originals = new Map<number, { mimeType: string; bytes: Buffer }>();
		for (const c of this.manifest.candidates) {
			if (previews.has(c.n) || c.mimeType === "image/svg+xml") continue;
			if (c.bytes > MAX_EMBEDDED_ORIGINAL_BYTES) continue;
			try {
				originals.set(c.n, this.readCandidate(c.n));
			} catch {
				// Shown as a link to the file instead.
			}
		}
		const rel = join(this.relDir, CONTACT_SHEET);
		writeFileInside(
			this.sharedDir,
			rel,
			contactSheetHtml(this.manifest, previews, originals),
			{ mkdirParents: false },
		);
		return rel;
	}
}

/** A previous job's manifest from this mission's `shared/images/`. */
export function readJobManifest(sharedDir: string, jobId: string): JobManifest {
	if (!JOB_ID_RE.test(jobId)) {
		throw new Error(`"${jobId}" is not an image job id (img-YYYYMMDD-…)`);
	}
	const read = readInside(sharedDir, join(IMAGES_DIR, jobId, MANIFEST), {
		maxBytes: MAX_MANIFEST_BYTES,
	});
	if (read.truncated) throw new Error(`Manifest of ${jobId} is too large`);
	const manifest = JSON.parse(read.bytes.toString("utf8")) as JobManifest;
	if (manifest.jobId !== jobId || !Array.isArray(manifest.candidates)) {
		throw new Error(`Manifest of ${jobId} is not a valid image job manifest`);
	}
	return manifest;
}

/**
 * A candidate's bytes. The file name is rebuilt from the candidate number
 * and an allowed extension, never taken from the manifest (which any agent
 * can edit), so a manifest cannot point the daemon at another file.
 */
export function readJobCandidate(
	sharedDir: string,
	manifest: Pick<JobManifest, "jobId" | "candidates">,
	n: number,
): { mimeType: string; bytes: Buffer } {
	const c = manifest.candidates.find((x) => x.n === n);
	if (!c || !Number.isInteger(n) || n < 1) {
		throw new Error(`Job ${manifest.jobId} has no candidate ${n}`);
	}
	const ext = EXT_BY_MIME[c.mimeType];
	const mimeType = ext ? MIME_BY_EXT[ext] : undefined;
	if (!ext || !mimeType) {
		throw new Error(`Candidate ${n} of ${manifest.jobId} has an unknown type`);
	}
	const read = readInside(
		sharedDir,
		join(IMAGES_DIR, manifest.jobId, `candidate-${n}.${ext}`),
		{ maxBytes: MAX_CANDIDATE_BYTES },
	);
	if (read.truncated) throw new Error(`Candidate ${n} is too large`);
	return { mimeType, bytes: read.bytes };
}

function money(usd: number, estimated: boolean): string {
	return `$${usd.toFixed(3)}${estimated ? " (estimated)" : ""}`;
}

/** The card's image as a data URL within the remaining embed budget, or a pointer to the file. */
function cardImage(
	c: CandidateRecord,
	preview: Buffer | undefined,
	original: { mimeType: string; bytes: Buffer } | undefined,
	budget: { left: number },
): string {
	const source = preview
		? { mimeType: "image/jpeg", bytes: preview }
		: original;
	if (source) {
		const b64 = source.bytes.toString("base64");
		if (b64.length <= budget.left) {
			budget.left -= b64.length;
			return `<img alt="candidate ${c.n}" src="data:${source.mimeType};base64,${b64}">`;
		}
	}
	return `<p class="nopreview">No preview: open ${escapeHtml(c.file)}</p>`;
}

/**
 * The contact sheet: every candidate with its model, cost, rationale, note
 * and prompt. Images are embedded (the Files panel previews HTML in a
 * sandboxed frame with no access to sibling files); SVG candidates appear
 * only as their rendered JPEG preview, never inlined. All text is escaped.
 */
export function contactSheetHtml(
	m: JobManifest,
	previews: ReadonlyMap<number, Buffer>,
	originals: ReadonlyMap<
		number,
		{ mimeType: string; bytes: Buffer }
	> = new Map(),
	embedBudget = CONTACT_SHEET_EMBED_BUDGET,
): string {
	const recommended = new Set(m.recommended ?? []);
	const budget = { left: embedBudget };
	const cards = m.candidates
		.map((c) => {
			const badge = recommended.has(c.n)
				? ' <span class="badge">recommended</span>'
				: "";
			return `<section class="card">
${cardImage(c, previews.get(c.n), originals.get(c.n), budget)}
<h2>Candidate ${c.n}${badge}</h2>
<p class="meta">${escapeHtml(c.file)} · ${escapeHtml(c.model)} · ${money(c.costUsd, c.costEstimated)}</p>
${c.note ? `<p>${escapeHtml(c.note)}</p>` : ""}
${c.rationale ? `<p class="why">${escapeHtml(c.rationale)}</p>` : ""}
<details><summary>Prompt</summary><pre>${escapeHtml(c.prompt)}</pre></details>
</section>`;
		})
		.join("\n");
	const critiques = m.critiques
		.map(
			(k) =>
				`<details><summary>Critique of ${k.candidates.join(", ")}</summary><pre>${escapeHtml(k.text)}</pre></details>`,
		)
		.join("\n");
	const t = m.totals;
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>Images ${escapeHtml(m.jobId)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:16px;color:#1d1d1f;background:#fafafa}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px}
.card img{width:100%;height:auto;display:block;background:#fff}
h1{font-size:20px}h2{font-size:16px;margin:8px 0 4px}
.meta,.why{color:#555;font-size:13px}.badge{background:#1a7f37;color:#fff;border-radius:4px;padding:1px 6px;font-size:12px}
pre{white-space:pre-wrap;font-size:12px}.brief{white-space:pre-wrap}
</style></head><body>
<h1>Image job ${escapeHtml(m.jobId)}</h1>
<p class="meta">${escapeHtml(m.status)}${m.statusDetail ? ` — ${escapeHtml(m.statusDetail)}` : ""} · ${t.images} image(s) · total ${money(t.totalUsd, t.estimated)} (images ${money(t.imageUsd, t.estimated)}, agent $${t.agentUsd.toFixed(3)})</p>
<p class="brief">${escapeHtml(m.brief)}</p>
${m.summary ? `<p>${escapeHtml(m.summary)}</p>` : ""}
<div class="grid">
${cards}
</div>
${critiques}
</body></html>
`;
}
