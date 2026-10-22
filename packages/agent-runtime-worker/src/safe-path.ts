/**
 * Path containment for everything the daemon reads or writes on behalf of a
 * less-trusted party — a cockpit request, an LLM tool argument, a job spec,
 * a web page's artifact — under a tree that agents can write to.
 *
 * The daemon runs as `magi-operator`, which can read every mission's data and
 * its own environment, while agents own `shared/` and their workdirs with
 * rwx. A plain `resolve(root, p).startsWith(root)` check is defeated three
 * ways, all seen in the 2026-10 audit (MS1, RS2, AR1): a symlink planted in
 * the tree that points at `/proc/self/environ` or another mission's volume,
 * a `..` that `resolve` cancels but a sibling-prefix root (`/x/root-evil`
 * passes `startsWith("/x/root")`) does not, and a swap of the final
 * component between the check and the open.
 *
 * `resolveInside` answers "where would this path physically land?": it
 * realpaths the root and the nearest existing ancestor of the request, so a
 * symlinked intermediate directory is seen for what it points at, and it
 * refuses anything that lands outside `root` or inside a pseudo filesystem.
 * The `*Inside` helpers then open with `O_NOFOLLOW`, so a symlink planted at
 * the final component after the check fails with ELOOP instead of being
 * followed. Intermediate components can still race in theory; the final one
 * — the only one an agent can swap cheaply — cannot.
 *
 * Roots are trusted (configured by the daemon, never by the request).
 */

import {
	closeSync,
	constants as fsc,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export class PathOutsideRootError extends Error {
	override readonly name = "PathOutsideRootError";
	constructor(
		readonly root: string,
		readonly requested: string,
		reason: string,
	) {
		super(`Path ${JSON.stringify(requested)} is not inside ${root}: ${reason}`);
	}
}

export class PathNotFoundError extends Error {
	override readonly name = "PathNotFoundError";
	constructor(readonly requested: string) {
		super(`Path ${JSON.stringify(requested)} does not exist`);
	}
}

/** Kernel-synthesised trees that are never legitimate data, whatever the root. */
const PSEUDO_FS_ROOTS = ["/proc", "/sys", "/dev"];

function within(rootReal: string, candidate: string): boolean {
	if (rootReal === sep) return candidate.startsWith(sep);
	return candidate === rootReal || candidate.startsWith(rootReal + sep);
}

function assertNotPseudoFs(root: string, requested: string, physical: string) {
	for (const pseudo of PSEUDO_FS_ROOTS) {
		if (within(pseudo, physical)) {
			throw new PathOutsideRootError(
				root,
				requested,
				`resolves into ${pseudo}`,
			);
		}
	}
}

export interface ResolveInsideOptions {
	/** Reject a path whose final component does not exist yet (reads). Default: allowed (writes). */
	mustExist?: boolean;
}

/**
 * The path to open for `requested` under `root`, or a throw. `requested` may
 * be relative to `root` or absolute (fine if it lands inside).
 *
 * Every *parent* component is realpath'd (so a symlinked intermediate
 * directory is seen for what it points at) and the not-yet-existing tail, if
 * any, is appended verbatim. The *final* component is kept as named, not
 * followed: if it is a symlink its target is checked for containment here,
 * but the returned path is the link itself, so an `O_NOFOLLOW` open on it
 * fails with ELOOP. That is what makes the check hold against a link swapped
 * in after it ran — the one race an agent can win cheaply.
 */
export function resolveInside(
	root: string,
	requested: string,
	opts: ResolveInsideOptions = {},
): string {
	if (requested.includes("\0")) {
		throw new PathOutsideRootError(root, requested, "contains a NUL byte");
	}
	// A missing root is a daemon configuration error, not an input error — let
	// the ENOENT propagate rather than wrapping it as a containment failure.
	const rootReal = realpathSync(root);
	const lexical = resolve(rootReal, requested);
	if (!within(rootReal, lexical)) {
		throw new PathOutsideRootError(root, requested, "escapes the root");
	}
	if (lexical === rootReal) return rootReal;

	// Walk up from the parent to the nearest component realpath can resolve.
	// A dangling symlink counts as missing here; the O_NOFOLLOW opens below
	// refuse it, so nothing can be read or created through it.
	const leaf = basename(lexical);
	const tail: string[] = [];
	let existing = dirname(lexical);
	let existingReal: string | null = null;
	for (;;) {
		try {
			existingReal = realpathSync(existing);
			break;
		} catch {
			const parent = dirname(existing);
			if (parent === existing) break;
			tail.unshift(basename(existing));
			existing = parent;
		}
	}
	if (existingReal === null) {
		throw new PathOutsideRootError(root, requested, "no resolvable ancestor");
	}
	const openPath = join(existingReal, ...tail, leaf);
	if (!within(rootReal, openPath)) {
		throw new PathOutsideRootError(
			root,
			requested,
			`resolves to ${openPath}, outside the root (symlink)`,
		);
	}
	assertNotPseudoFs(root, requested, openPath);

	// Where the final component points, if it exists and is a link.
	let target: string | null = null;
	if (tail.length === 0) {
		try {
			target = realpathSync(openPath);
		} catch {
			target = null; // missing, or a dangling link
		}
	}
	if (target !== null) {
		if (!within(rootReal, target)) {
			throw new PathOutsideRootError(
				root,
				requested,
				`is a symlink to ${target}, outside the root`,
			);
		}
		assertNotPseudoFs(root, requested, target);
	} else if (opts.mustExist) {
		throw new PathNotFoundError(requested);
	}
	return openPath;
}

export interface ReadInsideResult {
	bytes: Buffer;
	/** Full size on disk — larger than `bytes.length` when truncated. */
	size: number;
	truncated: boolean;
}

/**
 * Read a regular file under `root` without following a symlink at the final
 * component, reading at most `maxBytes` (default 50 MB). Throws
 * `PathNotFoundError` for a missing file and a plain Error for a directory,
 * device or FIFO — the daemon never streams from those.
 */
export function readInside(
	root: string,
	requested: string,
	opts: { maxBytes?: number } = {},
): ReadInsideResult {
	const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
	const path = resolveInside(root, requested, { mustExist: true });
	let fd: number;
	try {
		fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new PathNotFoundError(requested);
		if (code === "ELOOP") {
			throw new PathOutsideRootError(
				root,
				requested,
				"is a symlink (not followed)",
			);
		}
		throw e;
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) {
			throw new Error(
				`Path ${JSON.stringify(requested)} is not a regular file`,
			);
		}
		const toRead = Math.min(st.size, maxBytes);
		const bytes = Buffer.allocUnsafe(toRead);
		let off = 0;
		while (off < toRead) {
			const n = readSync(fd, bytes, off, toRead - off, off);
			if (n === 0) break;
			off += n;
		}
		return {
			bytes: off === toRead ? bytes : bytes.subarray(0, off),
			size: st.size,
			truncated: st.size > toRead,
		};
	} finally {
		closeSync(fd);
	}
}

export interface WriteInsideOptions {
	/** Fail with EEXIST instead of truncating an existing file. */
	exclusive?: boolean;
	/** Create missing parent directories (inside the root, by construction). Default true. */
	mkdirParents?: boolean;
	mode?: number;
}

/**
 * Write a file under `root`, creating it or truncating it, never through a
 * symlink at the final component (ELOOP). Returns the physical path written.
 */
export function writeFileInside(
	root: string,
	requested: string,
	data: string | Uint8Array,
	opts: WriteInsideOptions = {},
): string {
	const path = resolveInside(root, requested);
	if (opts.mkdirParents !== false) {
		mkdirSync(dirname(path), { recursive: true });
	}
	let flags = fsc.O_WRONLY | fsc.O_CREAT | fsc.O_NOFOLLOW;
	flags |= opts.exclusive ? fsc.O_EXCL : fsc.O_TRUNC;
	let fd: number;
	try {
		fd = openSync(path, flags, opts.mode ?? 0o644);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ELOOP") {
			throw new PathOutsideRootError(
				root,
				requested,
				"is a symlink (not followed)",
			);
		}
		throw e;
	}
	try {
		const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
		let off = 0;
		while (off < buf.length) {
			off += writeSync(fd, buf, off, buf.length - off);
		}
	} finally {
		closeSync(fd);
	}
	return path;
}

/**
 * Open a file under `root` for appending (creating it, and its parent
 * directories), never through a symlink at the final component. Returns the
 * fd; the caller owns it (e.g. `createWriteStream(null, { fd })`).
 */
export function openAppendInside(
	root: string,
	requested: string,
	mode = 0o644,
): number {
	const path = resolveInside(root, requested);
	mkdirSync(dirname(path), { recursive: true });
	try {
		return openSync(
			path,
			fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT | fsc.O_NOFOLLOW,
			mode,
		);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ELOOP") {
			throw new PathOutsideRootError(
				root,
				requested,
				"is a symlink (not followed)",
			);
		}
		throw e;
	}
}

/** Append to a file under `root`, never through a symlink at the final component. */
export function appendFileInside(
	root: string,
	requested: string,
	data: string,
): void {
	const fd = openAppendInside(root, requested);
	try {
		const buf = Buffer.from(data, "utf8");
		let off = 0;
		while (off < buf.length) {
			off += writeSync(fd, buf, off, buf.length - off);
		}
	} finally {
		closeSync(fd);
	}
}

/**
 * Create a directory under `root`. With `exclusive` (the default) the leaf
 * must not exist — a pre-planted symlink or directory fails with EEXIST
 * rather than being reused, which is what an artifact id directory needs.
 */
export function mkdirInside(
	root: string,
	requested: string,
	opts: { exclusive?: boolean; mode?: number } = {},
): string {
	const path = resolveInside(root, requested);
	if (opts.exclusive === false) {
		mkdirSync(path, { recursive: true, mode: opts.mode });
	} else {
		mkdirSync(dirname(path), { recursive: true });
		mkdirSync(path, { mode: opts.mode });
	}
	return path;
}
