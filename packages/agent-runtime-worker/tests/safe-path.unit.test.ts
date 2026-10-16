/**
 * safe-path.ts — the containment primitive every daemon-side read/write on an
 * agent-writable tree goes through (audit 2026-10: MS1, RS2, AR1). Real
 * filesystem in a tmpdir, real symlinks; no mocks, because the whole point is
 * what the kernel does with them.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mkdirInside,
	PathNotFoundError,
	PathOutsideRootError,
	readInside,
	resolveInside,
	writeFileInside,
} from "../src/safe-path.js";

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "safe-path-")));
	root = join(base, "root");
	outside = join(base, "outside");
	mkdirSync(join(root, "sub"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(root, "sub", "ok.txt"), "inside");
	writeFileSync(join(outside, "secret.txt"), "outside");
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("resolveInside", () => {
	it("returns the physical path of a relative path inside the root", () => {
		expect(resolveInside(root, "sub/ok.txt")).toBe(join(root, "sub", "ok.txt"));
		expect(resolveInside(root, "")).toBe(root);
		expect(resolveInside(root, ".")).toBe(root);
	});

	it("accepts an absolute path that lands inside the root", () => {
		expect(resolveInside(root, join(root, "sub", "ok.txt"))).toBe(
			join(root, "sub", "ok.txt"),
		);
	});

	it("rejects `..` traversal and absolute paths outside the root", () => {
		expect(() => resolveInside(root, "../outside/secret.txt")).toThrow(
			PathOutsideRootError,
		);
		expect(() => resolveInside(root, "sub/../../outside/secret.txt")).toThrow(
			PathOutsideRootError,
		);
		expect(() => resolveInside(root, join(outside, "secret.txt"))).toThrow(
			PathOutsideRootError,
		);
	});

	it("rejects a sibling whose name merely starts with the root's name", () => {
		mkdirSync(`${root}-evil`);
		writeFileSync(join(`${root}-evil`, "f"), "x");
		expect(() => resolveInside(root, `${root}-evil/f`)).toThrow(
			PathOutsideRootError,
		);
	});

	it("rejects a NUL byte", () => {
		expect(() => resolveInside(root, "sub/ok.txt\0.png")).toThrow(/NUL/);
	});

	it("sees through a symlinked intermediate directory that points outside", () => {
		symlinkSync(outside, join(root, "link"));
		expect(() => resolveInside(root, "link/secret.txt")).toThrow(
			/outside the root \(symlink\)/,
		);
		// A not-yet-existing file under that symlinked dir is just as outside.
		expect(() => resolveInside(root, "link/new.txt")).toThrow(
			PathOutsideRootError,
		);
	});

	it("sees through a symlink at the final component that points outside", () => {
		symlinkSync(join(outside, "secret.txt"), join(root, "leaf"));
		expect(() => resolveInside(root, "leaf")).toThrow(PathOutsideRootError);
	});

	it("follows a symlinked intermediate directory that stays inside the root, but names a final-component link as itself", () => {
		symlinkSync(join(root, "sub"), join(root, "alias"));
		expect(resolveInside(root, "alias/ok.txt")).toBe(
			join(root, "sub", "ok.txt"),
		);
		// The leaf link is contained (its target is inside), so it resolves — to
		// the link path, which an O_NOFOLLOW open then refuses (see readInside).
		symlinkSync(join(root, "sub", "ok.txt"), join(root, "leaf-in"));
		expect(resolveInside(root, "leaf-in")).toBe(join(root, "leaf-in"));
	});

	it("allows a not-yet-existing tail under an existing directory, unless mustExist", () => {
		expect(resolveInside(root, "sub/new/deeper.txt")).toBe(
			join(root, "sub", "new", "deeper.txt"),
		);
		expect(() =>
			resolveInside(root, "sub/new/deeper.txt", { mustExist: true }),
		).toThrow(PathNotFoundError);
	});

	it("refuses pseudo filesystems even when the root is broad enough to contain them", () => {
		if (!existsSync("/proc/self")) return;
		expect(() => resolveInside("/", "/proc/self/environ")).toThrow(
			/resolves into \/proc/,
		);
	});
});

describe("readInside", () => {
	it("reads a regular file and reports its size", () => {
		const r = readInside(root, "sub/ok.txt");
		expect(r.bytes.toString()).toBe("inside");
		expect(r).toMatchObject({ size: 6, truncated: false });
	});

	it("truncates at maxBytes and says so", () => {
		const r = readInside(root, "sub/ok.txt", { maxBytes: 2 });
		expect(r.bytes.toString()).toBe("in");
		expect(r).toMatchObject({ size: 6, truncated: true });
	});

	it("does not follow a symlink at the final component, even one that points inside", () => {
		// The check saw the target inside the root; the open still refuses the
		// link itself, so a link swapped in after the check cannot redirect it.
		symlinkSync(join(root, "sub", "ok.txt"), join(root, "sub", "ln.txt"));
		expect(() => readInside(root, "sub/ln.txt")).toThrow(/symlink/);
	});

	it("rejects a missing file and a directory", () => {
		expect(() => readInside(root, "sub/missing.txt")).toThrow(
			PathNotFoundError,
		);
		expect(() => readInside(root, "sub")).toThrow(/not a regular file/);
	});
});

describe("writeFileInside", () => {
	it("creates parents and writes inside the root", () => {
		const p = writeFileInside(root, "sub/new/file.txt", "hello");
		expect(p).toBe(join(root, "sub", "new", "file.txt"));
		expect(readFileSync(p, "utf8")).toBe("hello");
	});

	it("refuses to write through a symlink at the final component", () => {
		symlinkSync(join(outside, "secret.txt"), join(root, "sub", "evil.txt"));
		expect(() => writeFileInside(root, "sub/evil.txt", "pwned")).toThrow(
			PathOutsideRootError,
		);
		symlinkSync(join(root, "sub", "ok.txt"), join(root, "sub", "inner.txt"));
		expect(() => writeFileInside(root, "sub/inner.txt", "pwned")).toThrow(
			/symlink/,
		);
		expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside");
		expect(readFileSync(join(root, "sub", "ok.txt"), "utf8")).toBe("inside");
	});

	it("refuses a dangling symlink at the final component (cannot create through it)", () => {
		symlinkSync(join(outside, "new.txt"), join(root, "sub", "dangling.txt"));
		expect(() => writeFileInside(root, "sub/dangling.txt", "x")).toThrow(
			/symlink/,
		);
		expect(existsSync(join(outside, "new.txt"))).toBe(false);
	});

	it("exclusive mode fails on an existing file instead of truncating it", () => {
		expect(() =>
			writeFileInside(root, "sub/ok.txt", "x", { exclusive: true }),
		).toThrow(/EEXIST/);
		expect(readFileSync(join(root, "sub", "ok.txt"), "utf8")).toBe("inside");
	});
});

describe("mkdirInside", () => {
	it("creates the directory (and parents) inside the root", () => {
		expect(mkdirInside(root, "artifacts/id-1")).toBe(
			join(root, "artifacts", "id-1"),
		);
	});

	it("exclusive mode refuses a pre-planted symlink or directory at the leaf", () => {
		mkdirSync(join(root, "artifacts"));
		symlinkSync(outside, join(root, "artifacts", "planted-out"));
		expect(() => mkdirInside(root, "artifacts/planted-out")).toThrow(
			PathOutsideRootError,
		);
		symlinkSync(join(root, "sub"), join(root, "artifacts", "planted-in"));
		expect(() => mkdirInside(root, "artifacts/planted-in")).toThrow(/EEXIST/);
		mkdirSync(join(root, "artifacts", "taken"));
		expect(() => mkdirInside(root, "artifacts/taken")).toThrow(/EEXIST/);
	});
});

describe("edge cases", () => {
	it("mkdirInside in non-exclusive mode is idempotent and creates parents", () => {
		expect(mkdirInside(root, "a/b/c", { exclusive: false })).toBe(
			join(root, "a", "b", "c"),
		);
		expect(() =>
			mkdirInside(root, "a/b/c", { exclusive: false }),
		).not.toThrow();
	});

	it("readInside surfaces a permission error as-is (not as not-found or symlink)", () => {
		if (process.getuid?.() === 0) return; // root ignores mode bits
		writeFileSync(join(root, "sub", "locked.txt"), "x", { mode: 0o000 });
		expect(() => readInside(root, "sub/locked.txt")).toThrow(/EACCES/);
	});
});
