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
