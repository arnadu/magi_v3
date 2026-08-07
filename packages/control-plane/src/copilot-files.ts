/**
 * Read-only filesystem browsing for the control-plane copilot's own workdir.
 *
 * Unlike a mission's `/files/shared` (proxied to the execution-plane
 * MonitorServer, which reads the mission's Fly volume over HTTP), the
 * copilot runs in-process in the control-plane container, so its workdir
 * (COPILOT_WORKDIR) is on the control-plane's own local filesystem — this
 * reads it directly, no proxy needed. Response shapes match monitor-server.ts's
 * `serveFilePath` (DirEntry[]/FileNode) so the cockpit's existing types apply
 * unchanged.
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, extname, resolve } from "node:path";

const TEXT_FILE_MAX_BYTES = 10 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
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

const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".ico": "image/x-icon",
};

export type DirEntry = {
	name: string;
	type: "dir" | "file";
	size?: number;
	modified?: string;
};

export type FileNode =
	| { type: "dir"; path: string; entries: DirEntry[] }
	| {
			type: "file";
			name: string;
			encoding: "text" | "base64" | "binary";
			mimeType?: string;
			content?: string;
			truncated?: boolean;
	  };

/**
 * Resolve a user-supplied relative path against `root`, rejecting anything
 * that escapes it — including via a symlink (realpath, not just string
 * resolve; same class of protection as the F-003 fix in tools.ts's
 * checkPath). Returns null on any escape attempt.
 */
function resolveWithinRoot(root: string, userPath: string): string | null {
	const abs = resolve(root, userPath || ".");
	if (!abs.startsWith(root)) return null;
	if (!existsSync(abs)) return abs; // let the caller 404
	const real = realpathSync(abs);
	const realRoot = realpathSync(root);
	if (real !== realRoot && !real.startsWith(`${realRoot}/`)) return null;
	return abs;
}

/** Returns null if the path escapes root (caller should 400); a FileNode otherwise. */
export function readCopilotFileNode(
	root: string,
	userPath: string,
): FileNode | null {
	const abs = resolveWithinRoot(root, userPath);
	if (abs === null) return null;
	if (!existsSync(abs)) {
		return { type: "file", name: basename(abs), encoding: "binary" };
	}

	const stat = statSync(abs);
	if (stat.isDirectory()) {
		let names: string[];
		try {
			names = readdirSync(abs);
		} catch {
			names = [];
		}
		const entries: DirEntry[] = names.map((name) => {
			try {
				const s = statSync(resolve(abs, name));
				return {
					name,
					type: s.isDirectory() ? "dir" : "file",
					size: s.isDirectory() ? undefined : s.size,
					modified: s.mtime.toISOString(),
				};
			} catch {
				return { name, type: "file" };
			}
		});
		entries.sort((a, b) => {
			if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		return { type: "dir", path: userPath, entries };
	}

	const ext = extname(abs).toLowerCase();
	const imageMime = IMAGE_MIME[ext];
	if (imageMime) {
		return {
			type: "file",
			name: basename(abs),
			encoding: "base64",
			mimeType: imageMime,
			content: readFileSync(abs).toString("base64"),
		};
	}
	if (TEXT_EXTENSIONS.has(ext) || ext === "") {
		const raw = readFileSync(abs);
		return {
			type: "file",
			name: basename(abs),
			encoding: "text",
			mimeType: "text/plain",
			content: raw.slice(0, TEXT_FILE_MAX_BYTES).toString("utf8"),
			truncated: raw.length > TEXT_FILE_MAX_BYTES,
		};
	}
	return { type: "file", name: basename(abs), encoding: "binary" };
}
