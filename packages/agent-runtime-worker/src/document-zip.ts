/**
 * ZIP expansion for the document processor: each contained file becomes its
 * own artifact through the caller-supplied `recurse` (the public
 * `processBuffer`), bounded in three ways the original loop was not —
 * declared uncompressed size per entry and in total, read from the central
 * directory before anything is inflated; a compression-ratio check that
 * refuses a ZIP bomb; and a depth counter so an archive inside an archive is
 * listed, never expanded, whatever its file name says.
 */

import JSZip from "jszip";
import type {
	Handled,
	ProcessingStatus,
	ProcessLimits,
	ProcessOptions,
	ProcessResult,
} from "./document-processor.js";
import { processUnsupported, statusLine } from "./document-processor.js";

/** A compression ratio past this (on an entry this large) is a ZIP bomb, not a document. */
const ZIP_BOMB_RATIO = 200;
const ZIP_BOMB_MIN_BYTES = 5 * 1024 * 1024;

export async function processZip(
	bytes: Buffer,
	filename: string,
	opts: ProcessOptions,
	limits: ProcessLimits,
	recurse: (bytes: Buffer, opts: ProcessOptions) => Promise<ProcessResult>,
): Promise<Handled> {
	let zip: JSZip;
	try {
		zip = await JSZip.loadAsync(bytes);
	} catch (e) {
		return processUnsupported(
			bytes,
			filename,
			`Could not open ZIP — ${(e as Error).message}.`,
		);
	}

	const entries = Object.values(zip.files).filter((f) => !f.dir);
	const lines: string[] = [];
	const unprocessed: { item: string; reason: string }[] = [];
	let processed = 0;
	let inflatedTotal = 0;

	const skip = (entry: JSZip.JSZipObject, reason: string, note: string) => {
		lines.push(`- \`${entry.name}\` — ${note}`);
		unprocessed.push({ item: entry.name, reason });
	};

	for (const entry of entries) {
		if (entry.name.toLowerCase().endsWith(".zip")) {
			skip(entry, "nested-zip", "nested ZIP, not expanded");
			continue;
		}
		if (processed >= limits.maxZipFiles) {
			skip(entry, "over-file-limit", "not processed (file limit reached)");
			continue;
		}
		const refusal = preInflateRefusal(entry, limits, inflatedTotal);
		if (refusal) {
			skip(entry, refusal.reason, refusal.note);
			continue;
		}
		const entryBytes = Buffer.from(await entry.async("nodebuffer"));
		inflatedTotal += entryBytes.length;
		if (entryBytes.length > limits.maxZipEntryBytes) {
			skip(entry, "too-large", "not processed (larger than declared)");
			continue;
		}
		// Recurse via the public entry point — each contained file becomes its
		// own artifact. The depth counter, not the file name, is what stops a
		// ZIP inside a ZIP: processBuffer refuses to expand an archive at depth
		// ≥ 1 whatever it is called (a renamed inner archive used to be sniffed
		// by magic bytes and expanded again, to arbitrary depth).
		const sub = await recurse(entryBytes, {
			...opts,
			filename: entry.name.split("/").pop() ?? entry.name,
			zipDepth: (opts.zipDepth ?? 0) + 1,
		});
		processed++;
		if (sub.processingStatus === "unsupported" && sub.format === "zip") {
			unprocessed.push({ item: entry.name, reason: "nested-zip" });
		}
		// Same $SHARED_DIR ambiguity as the upload notification (issue #51 /
		// mission-copilot's ReadSharedFile follow-up): give the sharedDir-relative
		// path plainly, plus the Bash form, so a non-shell tool isn't handed a
		// literal "$SHARED_DIR" prefix it can't expand.
		const subRelPath = `artifacts/${sub.artifactId}/content.md`;
		lines.push(
			`- \`${entry.name}\` → artifact \`${sub.artifactId}\` (${sub.format}, ${sub.summary}) — path \`${subRelPath}\` (Bash: \`cat $SHARED_DIR/${subRelPath}\`)`,
		);
	}

	const status: ProcessingStatus =
		unprocessed.length > 0 ? "partial" : "complete";
	const content = [
		statusLine(
			status,
			status === "partial"
				? `${processed} of ${entries.length} files processed into their own artifacts.`
				: undefined,
		),
		"",
		`# ${filename} (${entries.length} files)`,
		"",
		lines.join("\n") || "(empty archive)",
	].join("\n");

	return {
		format: "zip",
		status,
		files: [{ name: "content.md", content }],
		unprocessed: unprocessed.length > 0 ? unprocessed : undefined,
		summary: `ZIP (${processed}/${entries.length} files)`,
	};
}

/** Sizes from the ZIP central directory (JSZip keeps them on a private field; 0 when absent). */
function declaredZipSizes(entry: JSZip.JSZipObject): {
	compressed: number;
	uncompressed: number;
} {
	const data = (
		entry as JSZip.JSZipObject & {
			_data?: { compressedSize?: number; uncompressedSize?: number };
		}
	)._data;
	return {
		compressed: data?.compressedSize ?? 0,
		uncompressed: data?.uncompressedSize ?? 0,
	};
}

const fmtMb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(0);

/**
 * Sizes come from the central directory, before any inflation: a 200 KB
 * archive of 200 MB of zeros used to be inflated whole (and copied once more)
 * on the daemon thread. Returns why an entry must not be inflated, or null.
 */
function preInflateRefusal(
	entry: JSZip.JSZipObject,
	limits: ProcessLimits,
	inflatedTotal: number,
): { reason: string; note: string } | null {
	const declared = declaredZipSizes(entry);
	if (declared.uncompressed > limits.maxZipEntryBytes) {
		return {
			reason: "too-large",
			note: `not processed (${fmtMb(declared.uncompressed)} MB uncompressed exceeds the ${fmtMb(limits.maxZipEntryBytes)} MB per-file limit)`,
		};
	}
	if (
		declared.compressed > 0 &&
		declared.uncompressed > ZIP_BOMB_MIN_BYTES &&
		declared.uncompressed / declared.compressed > ZIP_BOMB_RATIO
	) {
		return {
			reason: "suspicious-compression-ratio",
			note: "not processed (compression ratio looks like a ZIP bomb)",
		};
	}
	if (inflatedTotal + declared.uncompressed > limits.maxZipTotalBytes) {
		return {
			reason: "over-size-limit",
			note: `not processed (archive exceeds the ${fmtMb(limits.maxZipTotalBytes)} MB total limit)`,
		};
	}
	return null;
}
