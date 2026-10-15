/**
 * copilot-files.ts's readCopilotFileNode — path-boundary + symlink-escape
 * protection, same class of guard as the F-003 fix (tools.ts's checkPath).
 * Pure filesystem, no Mongo, no network.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCopilotFileNode } from "../src/copilot-files.js";

describe("readCopilotFileNode", () => {
	let root: string;
	let outside: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "copilot-files-root-"));
		outside = mkdtempSync(join(tmpdir(), "copilot-files-outside-"));
		writeFileSync(join(root, "notes.txt"), "hello from inside root");
		writeFileSync(join(outside, "secret.txt"), "should never be readable");
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "sub", "nested.md"), "# nested");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("lists the root directory", () => {
		const node = readCopilotFileNode(root, "");
		expect(node?.type).toBe("dir");
		if (node?.type !== "dir") throw new Error("expected dir");
		const names = node.entries.map((e) => e.name).sort();
		expect(names).toEqual(["notes.txt", "sub"]);
	});

	it("reads a text file's content", () => {
		const node = readCopilotFileNode(root, "notes.txt");
		expect(node?.type).toBe("file");
		if (node?.type !== "file") throw new Error("expected file");
		expect(node.encoding).toBe("text");
		expect(node.content).toBe("hello from inside root");
	});

	it("browses into a subdirectory", () => {
		const node = readCopilotFileNode(root, "sub");
		expect(node?.type).toBe("dir");
		if (node?.type !== "dir") throw new Error("expected dir");
		expect(node.entries.map((e) => e.name)).toEqual(["nested.md"]);
	});

	it("rejects a lexical .. traversal outside root", () => {
		expect(readCopilotFileNode(root, "../")).toBeNull();
		expect(readCopilotFileNode(root, "../../etc/passwd")).toBeNull();
	});

	it("rejects a symlink inside root that resolves outside root", () => {
		symlinkSync(outside, join(root, "escape"));
		expect(readCopilotFileNode(root, "escape/secret.txt")).toBeNull();
	});

	it("returns a placeholder binary node for a nonexistent path, without reading anything", () => {
		const node = readCopilotFileNode(root, "does-not-exist.txt");
		expect(node).toEqual({
			type: "file",
			name: "does-not-exist.txt",
			encoding: "binary",
		});
	});
});

/**
 * X-TENANT3 (2026-10-15 audit): one copilot workdir used to serve every user.
 * Each user's copilot now has its own subdirectory, so the files route must
 * never let one user's root reach a sibling user's — including a sibling
 * whose id shares a prefix (`copilot-u1` vs `copilot-u10`).
 */
describe("per-user copilot roots", () => {
	let base: string;
	let rootU1: string;
	let rootU10: string;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "copilot-users-"));
		rootU1 = join(base, "copilot-u1");
		rootU10 = join(base, "copilot-u10");
		mkdirSync(rootU1);
		mkdirSync(rootU10);
		writeFileSync(join(rootU1, "mine.txt"), "u1's file");
		writeFileSync(join(rootU10, "secret.txt"), "u10's file");
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	it("reads the caller's own file", () => {
		const node = readCopilotFileNode(rootU1, "mine.txt");
		expect(node).toMatchObject({ type: "file", content: "u1's file" });
	});

	it("rejects a path into a sibling user's root that shares a name prefix", () => {
		expect(readCopilotFileNode(rootU1, "../copilot-u10/secret.txt")).toBeNull();
		expect(readCopilotFileNode(rootU1, "../copilot-u10")).toBeNull();
	});

	it("returns an empty listing for a user whose copilot has never run", () => {
		const node = readCopilotFileNode(join(base, "copilot-never"), "");
		expect(node).toEqual({ type: "dir", path: "", entries: [] });
	});
});
