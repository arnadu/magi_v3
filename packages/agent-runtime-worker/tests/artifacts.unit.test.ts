/**
 * artifacts.ts — the daemon writes artifact directories into agent-writable
 * `shared/` (AR1/AR2/DOC4, audit 2026-10). Real tmpdir, real symlinks.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	generateArtifactId,
	safeEntryName,
	saveArtifact,
	saveUpload,
} from "../src/artifacts.js";

let base: string;
let shared: string;
let outside: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "artifacts-")));
	shared = join(base, "shared");
	outside = join(base, "outside");
	mkdirSync(shared);
	mkdirSync(outside);
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

const meta = {
	"@type": "Article",
	id: "x",
	name: "x",
	dateCreated: "2026-10-16T00:00:00Z",
};

describe("generateArtifactId", () => {
	it("is slug + UTC timestamp + random suffix, and two calls in the same second differ", () => {
		const a = generateArtifactId("https://reuters.com/article/foo");
		const b = generateArtifactId("https://reuters.com/article/foo");
		expect(a).toMatch(/^reuters-com-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
		expect(b).not.toBe(a);
		expect(generateArtifactId("/home/user/docs/report.pdf")).toMatch(
			/^report-\d{8}T\d{6}Z-[0-9a-f]{4}$/,
		);
	});
});

describe("safeEntryName", () => {
	it("keeps one path component and replaces empty, dot and dot-dot names", () => {
		expect(safeEntryName("content.md")).toBe("content.md");
		expect(safeEntryName("dir/sub/image-0.jpg")).toBe("image-0.jpg");
		expect(safeEntryName("../../etc/passwd")).toBe("passwd");
		expect(safeEntryName("..")).toBe("file");
		expect(safeEntryName(".")).toBe("file");
		expect(safeEntryName("")).toBe("file");
		expect(safeEntryName("a\0b.txt")).toBe("ab.txt");
	});
});

describe("saveArtifact", () => {
	it("writes files and meta.json under shared/artifacts/<id>", async () => {
		const dir = await saveArtifact(
			shared,
			"site-20260101T000000Z-abcd",
			[
				{ name: "content.md", content: "# hi" },
				{ name: "image-0.jpg", content: Buffer.from([1, 2, 3]) },
			],
			meta,
		);
		expect(dir).toBe(join(shared, "artifacts", "site-20260101T000000Z-abcd"));
		expect(readFileSync(join(dir, "content.md"), "utf8")).toBe("# hi");
		expect(readFileSync(join(dir, "image-0.jpg"))).toEqual(
			Buffer.from([1, 2, 3]),
		);
		expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))).toEqual(
			meta,
		);
	});

	it("refuses an id directory pre-planted as a symlink to somewhere else (AR1)", async () => {
		mkdirSync(join(shared, "artifacts"));
		symlinkSync(outside, join(shared, "artifacts", "planted"));
		await expect(
			saveArtifact(
				shared,
				"planted",
				[{ name: "content.md", content: "x" }],
				meta,
			),
		).rejects.toThrow();
		expect(readdirSync(outside)).toEqual([]);
	});

	it("refuses an id directory that already exists, instead of writing into it", async () => {
		mkdirSync(join(shared, "artifacts", "taken"), { recursive: true });
		await expect(
			saveArtifact(
				shared,
				"taken",
				[{ name: "content.md", content: "x" }],
				meta,
			),
		).rejects.toThrow(/EEXIST/);
	});

	it("refuses when the artifacts parent itself is a symlink out of the tree", async () => {
		symlinkSync(outside, join(shared, "artifacts"));
		await expect(
			saveArtifact(
				shared,
				"id-1",
				[{ name: "content.md", content: "x" }],
				meta,
			),
		).rejects.toThrow(/not inside/);
		expect(existsSync(join(outside, "id-1"))).toBe(false);
	});

	it("sanitises entry names from untrusted sources instead of aborting (DOC4) and never clobbers", async () => {
		const dir = await saveArtifact(
			shared,
			"zip-1",
			[
				{ name: "..", content: "a" },
				{ name: "../../x/..", content: "b" },
				{ name: "nested/dir/report.csv", content: "c" },
				{ name: "meta.json", content: "{}" },
			],
			meta,
		);
		const names = readdirSync(dir).sort();
		expect(names).toEqual(
			["1-file", "file", "meta.1.json", "meta.json", "report.csv"].sort(),
		);
		expect(readFileSync(join(dir, "file"), "utf8")).toBe("a");
		expect(readFileSync(join(dir, "1-file"), "utf8")).toBe("b");
		expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))).toEqual(
			meta,
		);
	});
});

describe("saveUpload", () => {
	it("writes under <workdir>/uploads/<id> with the same guarantees", async () => {
		const dir = await saveUpload(
			shared,
			"up-1",
			[{ name: "report.pdf", content: Buffer.from("pdf") }],
			{
				"@type": "UploadedFile",
				id: "up-1",
				name: "report.pdf",
				dateCreated: "2026-10-16T00:00:00Z",
			},
		);
		expect(dir).toBe(join(shared, "uploads", "up-1"));
		expect(readFileSync(join(dir, "report.pdf"), "utf8")).toBe("pdf");
	});
});
