/**
 * The monitor server's file surface: browsing, reading, downloading and the
 * containment helpers the write/edit/upload routes share. Everything here
 * runs as the daemon on trees agents can write to, so every path goes
 * through safe-path.ts (realpath'd parents, final component never followed)
 * and nothing is streamed or zipped from a symlink or special file.
 */

import {
	closeSync,
	createReadStream,
	constants as fsc,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { basename, extname, join, relative } from "node:path";
import JSZip from "jszip";
import { PathNotFoundError, readInside, resolveInside } from "./safe-path.js";

export const TEXT_FILE_MAX_BYTES = 10 * 1024 * 1024;

export const TEXT_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".json",
	".yaml",
	".yml",
	".toml",
	".ts",
	".js",
	".mjs",
	".py",
	".sh",
	".bash",
	".env",
	".csv",
	".log",
	".xml",
	".html",
	".css",
	".sql",
	".r",
]);

export const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".ico": "image/x-icon",
};

/** Hard cap on the uncompressed bytes a single zip download may gather. */
export const DOWNLOAD_ZIP_MAX_BYTES = 200 * 1024 * 1024;

/** Larger images are not inlined as base64 into a JSON file response. */
const IMAGE_FILE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Recursively add a file or directory subtree to a zip, paths relative to
 * `base`. Symlinks and special files are skipped (never followed — the tree
 * is agent-writable), and `budget.remaining` is decremented per file so a
 * subtree bigger than the cap fails before anything is buffered in memory.
 */

/**
 * `Content-Disposition` for an agent-chosen filename. Node refuses a header
 * value outside Latin-1 (a non-ASCII name made every download a 500), and a
 * quote in the name broke the quoted-string. RFC 6266: an ASCII-safe
 * `filename=` fallback plus `filename*=UTF-8''` with the real name encoded.
 */
export function contentDisposition(
	name: string,
	disposition: "attachment" | "inline" = "attachment",
): string {
	const safe =
		name
			.replace(/[\r\n]/g, "")
			.replace(/[^\x20-\x7e]/g, "_")
			.replace(/["\\]/g, "_")
			.trim() || "download";
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	const star = name && encoded !== safe ? `; filename*=UTF-8''${encoded}` : "";
	return `${disposition}; filename="${safe}"${star}`;
}

export function addToZip(
	zip: JSZip,
	abs: string,
	base: string,
	budget: { remaining: number },
): void {
	const stat = lstatSync(abs);
	if (stat.isDirectory()) {
		for (const name of readdirSync(abs)) {
			// Skip the git metadata dir — it bloats the archive and isn't a deliverable.
			if (name === ".git") continue;
			addToZip(zip, join(abs, name), base, budget);
		}
		return;
	}
	if (!stat.isFile()) return;
	budget.remaining -= stat.size;
	if (budget.remaining < 0) {
		throw new Error(
			`Download exceeds the ${DOWNLOAD_ZIP_MAX_BYTES / (1024 * 1024)} MB zip limit`,
		);
	}
	const rel = relative(base, abs) || basename(abs);
	const fd = openSync(abs, fsc.O_RDONLY | fsc.O_NOFOLLOW);
	try {
		const buf = Buffer.allocUnsafe(stat.size);
		let off = 0;
		while (off < buf.length) {
			const n = readSyncFully(fd, buf, off);
			if (n === 0) break;
			off += n;
		}
		zip.file(rel, off === buf.length ? buf : buf.subarray(0, off));
	} finally {
		closeSync(fd);
	}
}

function readSyncFully(fd: number, buf: Buffer, off: number): number {
	return readSync(fd, buf, off, buf.length - off, off);
}

/**
 * Resolve a request path inside `root` or answer the request with 400/404.
 * Returns the path to open, or null when a response has been written.
 */
export function containOrReply(
	root: string,
	userPath: string,
	res: ServerResponse,
	opts: { mustExist?: boolean } = {},
): string | null {
	try {
		return resolveInside(root, userPath, opts);
	} catch (e) {
		if (e instanceof PathNotFoundError) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Not found" }));
		} else {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Path outside root" }));
		}
		return null;
	}
}

/**
 * Operator/copilot writes must not reach into git's own files: `.git/*`,
 * `.gitattributes`, `.gitignore`, `.gitmodules` under the shared tree can
 * change what safe-git.ts commits or how it reads the tree.
 */
export function touchesGitMetadata(userPath: string): boolean {
	return userPath
		.split(/[\\/]+/)
		.some((component) => component.toLowerCase().startsWith(".git"));
}

/** One path component for an uploaded file; `..`, `.` and empty names become a placeholder. */
export function safeUploadName(filename: string): string {
	const base = basename(filename.replace(/\0/g, ""));
	return base === "" || base === "." || base === ".." ? "upload" : base;
}

/** Stream a file (attachment) or a folder subtree as a zip from sharedDir. */
export function handleDownload(
	sharedDir: string,
	rawUrl: string,
	res: ServerResponse,
): void {
	const params = new URL(rawUrl, "http://x").searchParams;
	const userPath = params.get("path") ?? "";
	const asZip = params.get("format") === "zip";
	// Sprint 27: lets a chat/mailbox message embed an inline <img src=...>
	// pointing straight at this route (renderMarkdown's image support) —
	// the default (no `inline`) keeps forcing a download, unchanged for the
	// Files panel's own "Download" button and every other existing caller.
	const inline = params.get("inline") === "1";

	const abs = containOrReply(sharedDir, userPath, res, {
		mustExist: true,
	});
	if (!abs) return;

	// lstat, not stat: a symlink at the requested path is served as nothing
	// — neither followed into a zip nor streamed.
	const stat = lstatSync(abs);
	if (stat.isDirectory() || asZip) {
		const zip = new JSZip();
		try {
			addToZip(zip, abs, abs, { remaining: DOWNLOAD_ZIP_MAX_BYTES });
		} catch (e) {
			res.writeHead(413, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: (e as Error).message }));
			return;
		}
		zip
			.generateAsync({ type: "nodebuffer" })
			.then((buf) => {
				res.writeHead(200, {
					"Content-Type": "application/zip",
					"Content-Disposition": contentDisposition(
						`${basename(abs) || "download"}.zip`,
					),
				});
				res.end(buf);
			})
			.catch((e: Error) => {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: e.message }));
			});
		return;
	}

	// Open without following a final-component symlink, then stream from
	// the descriptor — the open is the check (ELOOP on a link, EISDIR etc.).
	let fd: number;
	try {
		fd = openSync(abs, fsc.O_RDONLY | fsc.O_NOFOLLOW);
	} catch (e) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				error: `Not a readable file: ${(e as NodeJS.ErrnoException).code}`,
			}),
		);
		return;
	}
	if (!fstatSync(fd).isFile()) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Not a regular file" }));
		return;
	}

	const imageMime = inline ? IMAGE_MIME[extname(abs).toLowerCase()] : undefined;
	// Never let the browser guess a type, on any of these responses: the
	// bytes are agent-authored.
	res.setHeader("X-Content-Type-Options", "nosniff");
	if (imageMime) {
		// An <img> renders regardless of Content-Disposition, so the inline
		// variant still works for the markdown image syntax — but SVG is a
		// document, and navigating to it would run its scripts on the cockpit
		// origin (MS4/MT1): force a download on navigation and sandbox it.
		const headers: Record<string, string> = { "Content-Type": imageMime };
		if (imageMime === "image/svg+xml") {
			headers["Content-Disposition"] = contentDisposition(basename(abs));
			headers["Content-Security-Policy"] =
				"sandbox; default-src 'none'; style-src 'unsafe-inline'";
		}
		res.writeHead(200, headers);
		createReadStream(abs, { fd }).pipe(res);
		return;
	}

	res.writeHead(200, {
		"Content-Type": "application/octet-stream",
		"Content-Disposition": contentDisposition(basename(abs)),
	});
	createReadStream(abs, { fd }).pipe(res);
}

export function serveFileNode(
	root: string,
	userPath: string,
	res: ServerResponse,
): void {
	const abs = containOrReply(root, userPath, res, { mustExist: true });
	if (!abs) return;
	// lstat: a symlink at the requested path is listed as such, never followed.
	const stat = lstatSync(abs);
	if (stat.isDirectory()) {
		let entries: string[];
		try {
			entries = readdirSync(abs);
		} catch {
			entries = [];
		}
		const listed = entries.map((name) => {
			try {
				const s = lstatSync(join(abs, name));
				const type = s.isDirectory()
					? "dir"
					: s.isSymbolicLink()
						? "symlink"
						: "file";
				return {
					name,
					type,
					size: type === "file" ? s.size : undefined,
					modified: s.mtime.toISOString(),
				};
			} catch {
				return { name, type: "file" as const };
			}
		});
		listed.sort((a, b) => {
			if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ type: "dir", path: userPath, entries: listed }));
		return;
	}
	// File — read through the O_NOFOLLOW path; a symlink or special file 400s.
	const ext = extname(abs).toLowerCase();
	const imageMime = IMAGE_MIME[ext];
	const isText = TEXT_EXTENSIONS.has(ext) || ext === "";
	let read: ReturnType<typeof readInside> | null = null;
	if (imageMime || isText) {
		try {
			read = readInside(root, userPath, {
				maxBytes: imageMime ? IMAGE_FILE_MAX_BYTES : TEXT_FILE_MAX_BYTES,
			});
		} catch (e) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: (e as Error).message }));
			return;
		}
	}
	res.writeHead(200, { "Content-Type": "application/json" });
	if (imageMime && read) {
		res.end(
			JSON.stringify({
				type: "file",
				name: basename(abs),
				encoding: "base64",
				mimeType: imageMime,
				content: read.bytes.toString("base64"),
				truncated: read.truncated,
			}),
		);
		return;
	}
	if (isText && read) {
		res.end(
			JSON.stringify({
				type: "file",
				name: basename(abs),
				encoding: "text",
				mimeType: "text/plain",
				content: read.bytes.toString("utf8"),
				truncated: read.truncated,
			}),
		);
		return;
	}
	res.end(
		JSON.stringify({ type: "file", name: basename(abs), encoding: "binary" }),
	);
}

/** The cockpit editor's request body, or null after a 400 has been written. */
export function parseEditRequest(
	rawBody: string,
	res: ServerResponse,
): { userPath: string; content: string; expectedHead?: string } | null {
	const bad = (error: string): null => {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error }));
		return null;
	};
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return bad("Invalid JSON");
	}
	const { path, content, expectedHead } = (parsed ?? {}) as Record<
		string,
		unknown
	>;
	if (typeof path !== "string" || typeof content !== "string") {
		return bad("path (string) and content (string) are required");
	}
	if (expectedHead !== undefined && typeof expectedHead !== "string") {
		return bad("expectedHead must be a string");
	}
	return {
		userPath: path,
		content,
		...(expectedHead !== undefined ? { expectedHead } : {}),
	};
}

/**
 * Optimistic concurrency for the editor: it sends the commit it loaded; if an
 * agent has committed the file since, refuse rather than overwrite its work
 * (FP1). A file with no history yet has nothing to compare against.
 */
export function editHeadConflict(
	currentHead: string | null,
	expectedHead: string | undefined,
	relPath: string,
): string | null {
	if (expectedHead === undefined || currentHead === null) return null;
	if (currentHead === expectedHead) return null;
	return `${relPath} changed since you opened it (now at ${currentHead.slice(0, 8)}, you loaded ${expectedHead.slice(0, 8)}) — reload the file and re-apply your edit.`;
}
