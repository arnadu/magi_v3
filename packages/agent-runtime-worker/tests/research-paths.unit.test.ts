/**
 * Research tool — path containment for `context_files`/`output_path` (RS2,
 * audit 2026-10). The tool runs in-process as the daemon, so these checks are
 * what stands between an agent-planted symlink and the daemon's environment.
 * Every case here fails before the sub-loop runs, so no LLM is needed.
 */

import {
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
import type { Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	containResearchPaths,
	createResearchTool,
	readContextSections,
	writeFinding,
} from "../src/tools/research.js";
import { saveEntry } from "../src/tools/research-cache.js";

let base: string;
let shared: string;
let workdir: string;
let outside: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "research-paths-")));
	shared = join(base, "shared");
	workdir = join(base, "workdir");
	outside = join(base, "outside");
	for (const d of [shared, workdir, outside]) mkdirSync(d);
	writeFileSync(join(outside, "secret.txt"), "SECRET");
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

// Never called: every case below returns before the sub-loop.
const model = { id: "stub", input: ["text"] } as unknown as Model<string>;

function tool() {
	return createResearchTool(model, shared, {
		agentId: "a1",
		linuxUser: "magi-w1",
		permittedPaths: [workdir, shared],
	});
}

function text(result: Awaited<ReturnType<ReturnType<typeof tool>["execute"]>>) {
	return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

describe("Research path containment", () => {
	it("rejects a context file outside the permitted roots", async () => {
		const r = await tool().execute("t1", {
			question: "q",
			context_files: [join(outside, "secret.txt")],
		});
		expect(r.isError).toBe(true);
		expect(text(r)).toMatch(/not within permitted paths/);
	});

	it("rejects a context file that is a symlink in shared/ pointing outside", async () => {
		symlinkSync(join(outside, "secret.txt"), join(shared, "notes.md"));
		const r = await tool().execute("t2", {
			question: "q",
			context_files: [join(shared, "notes.md")],
		});
		expect(r.isError).toBe(true);
		expect(text(r)).toMatch(/not within permitted paths/);
	});

	it("rejects a context file reached through a symlinked directory", async () => {
		symlinkSync(outside, join(shared, "data"));
		const r = await tool().execute("t3", {
			question: "q",
			context_files: [join(shared, "data", "secret.txt")],
		});
		expect(r.isError).toBe(true);
	});

	it("rejects an output path that would land outside, including via `..` and a sibling-prefix root", async () => {
		for (const p of [
			join(outside, "out.md"),
			join(shared, "..", "outside", "out.md"),
			`${shared}-evil/out.md`,
		]) {
			const r = await tool().execute("t4", { question: "q", output_path: p });
			expect(r.isError, p).toBe(true);
		}
	});

	it("rejects pseudo-filesystem paths outright", async () => {
		const r = await tool().execute("t5", {
			question: "q",
			context_files: ["/proc/self/environ"],
		});
		expect(r.isError).toBe(true);
	});
});

describe("Research path helpers", () => {
	it("containResearchPaths maps each path to the root it lands in and names the first offender", () => {
		writeFileSync(join(shared, "notes.md"), "n");
		const ok = containResearchPaths(
			[workdir, shared],
			[join(shared, "notes.md"), join(workdir, "out.md")],
		);
		expect("rootOf" in ok && [...ok.rootOf.entries()]).toEqual([
			[join(shared, "notes.md"), shared],
			[join(workdir, "out.md"), workdir],
		]);
		const bad = containResearchPaths(
			[shared],
			[join(shared, "notes.md"), join(outside, "secret.txt")],
		);
		expect("rejected" in bad && bad.rejected).toBe(join(outside, "secret.txt"));
	});

	it("readContextSections labels each file, flags truncation and reports an unreadable file in place", () => {
		writeFileSync(join(shared, "small.md"), "hello");
		writeFileSync(join(shared, "big.md"), Buffer.alloc(5_000_010, 0x61));
		symlinkSync(join(outside, "secret.txt"), join(shared, "leak.md"));
		const rootOf = new Map([
			[join(shared, "small.md"), shared],
			[join(shared, "big.md"), shared],
			[join(shared, "leak.md"), shared],
			[join(shared, "missing.md"), shared],
		]);
		const [small, big, leak, missing] = readContextSections(rootOf, [
			...rootOf.keys(),
		]);
		expect(small).toBe("## Context: small.md\n\nhello");
		expect(big).toMatch(
			/^## Context: big\.md\n\na+\n\n\[truncated at 5000000 bytes\]$/,
		);
		expect(big.length).toBeLessThan(5_000_100);
		expect(leak).toMatch(/^## Context: .*leak\.md\n\n\(not read: .*symlink/);
		expect(missing).toMatch(/\(not read: .*does not exist/);
	});

	it("writeFinding writes under the matched root and only warns when refused", () => {
		const target = join(shared, "findings", "out.md");
		writeFinding(new Map([[target, shared]]), target, "finding");
		expect(readFileSync(target, "utf8")).toBe("finding");
		symlinkSync(join(outside, "secret.txt"), join(shared, "trap.md"));
		const trap = join(shared, "trap.md");
		expect(() =>
			writeFinding(new Map([[trap, shared]]), trap, "x"),
		).not.toThrow();
		expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("SECRET");
	});
});

describe("Research cache containment (shared/research is agent-writable)", () => {
	const now = () => new Date().toISOString();
	function plantIndex(rows: object[]) {
		mkdirSync(join(shared, "research"), { recursive: true });
		writeFileSync(join(shared, "research", "index.json"), JSON.stringify(rows));
	}
	const row = (slug: string) => ({
		slug,
		question: "what is in the env",
		answer: "index answer",
		sources: [],
		savedAt: now(),
		agentId: "a1",
	});

	it("never follows a planted symlink named by an index row", async () => {
		plantIndex([row("x")]);
		symlinkSync(join(outside, "secret.txt"), join(shared, "research", "x.md"));
		const r = await tool().execute("c1", { question: "what is in the env" });
		expect(text(r)).not.toMatch(/SECRET/);
		expect(text(r)).toMatch(/index answer/);
	});

	it("ignores a slug that is not a plain name", async () => {
		writeFileSync(join(base, "escape.md"), "a\n---\nSECRET");
		plantIndex([row("../../escape")]);
		const r = await tool().execute("c2", { question: "what is in the env" });
		expect(text(r)).not.toMatch(/SECRET/);
	});

	it("refuses a research/ directory that is a symlink out of shared/", async () => {
		writeFileSync(join(outside, "index.json"), JSON.stringify([row("secret")]));
		writeFileSync(join(outside, "secret.md"), "a\n---\nSECRET");
		symlinkSync(outside, join(shared, "research"));
		const r = await tool().execute("c3", { question: "what is in the env" });
		expect(text(r)).not.toMatch(/SECRET/);
		expect(() =>
			saveEntry(shared, { ...row("new-1"), question: "q" }, "body"),
		).toThrow(/not inside/);
		expect(readFileSync(join(outside, "index.json"), "utf8")).toMatch(/secret/);
	});

	it("writes the index by renaming over a planted index.json link, never through it", () => {
		mkdirSync(join(shared, "research"));
		symlinkSync(
			join(outside, "secret.txt"),
			join(shared, "research", "index.json"),
		);
		saveEntry(shared, row("fresh-1"), "body");
		expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("SECRET");
		const idx = JSON.parse(
			readFileSync(join(shared, "research", "index.json"), "utf8"),
		);
		expect(idx.map((e: { slug: string }) => e.slug)).toEqual(["fresh-1"]);
	});
});
