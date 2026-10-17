/**
 * monitor-files.ts — the monitor server's file surface, exercised without
 * HTTP or Mongo: real tmpdir and symlinks, a minimal ServerResponse stand-in
 * that captures status, headers and body (including piped streams).
 */

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addToZip,
	containOrReply,
	DOWNLOAD_ZIP_MAX_BYTES,
	handleDownload,
	safeUploadName,
	serveFileNode,
	touchesGitMetadata,
} from "../src/monitor-files.js";

interface Captured {
	res: ServerResponse;
	status: () => number;
	headers: () => Record<string, string>;
	body: () => Promise<Buffer>;
}

function fakeResponse(): Captured {
	const chunks: Buffer[] = [];
	let status = 0;
	let headers: Record<string, string> = {};
	const w = new Writable({
		write(chunk, _enc, cb) {
			chunks.push(Buffer.from(chunk));
			cb();
		},
	});
	const done = new Promise<void>((resolve) => w.on("finish", () => resolve()));
	const res = w as unknown as ServerResponse & {
		writeHead: (s: number, h?: Record<string, string>) => ServerResponse;
		setHeader: (k: string, v: string) => ServerResponse;
	};
	res.setHeader = (k, v) => {
		headers[k] = v;
		return res;
	};
	res.writeHead = (s, h) => {
		status = s;
		headers = { ...headers, ...(h ?? {}) };
		return res;
	};
	const origEnd = w.end.bind(w);
	(res as unknown as { end: (b?: unknown) => void }).end = (b?: unknown) => {
		if (b !== undefined) chunks.push(Buffer.from(b as string | Buffer));
		origEnd();
	};
	return {
		res,
		status: () => status,
		headers: () => headers,
		body: async () => {
			await done;
			return Buffer.concat(chunks);
		},
	};
}

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "monitor-files-")));
	root = join(base, "shared");
	outside = join(base, "outside");
	mkdirSync(join(root, "docs"), { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(root, "docs", "a.md"), "# A");
	writeFileSync(join(root, "docs", "pic.png"), Buffer.from([0x89, 0x50]));
	writeFileSync(
		join(root, "docs", "evil.svg"),
		'<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
	);
	writeFileSync(join(root, "docs", "blob.bin"), Buffer.from([0, 1, 2]));
	writeFileSync(join(outside, "secret.txt"), "secret");
	symlinkSync(join(outside, "secret.txt"), join(root, "docs", "leak.txt"));
	symlinkSync(join(root, "docs", "a.md"), join(root, "docs", "alias.md"));
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("helpers", () => {
	it("touchesGitMetadata flags any .git* component, case-insensitively", () => {
		for (const p of [
			".git/config",
			"sub/.gitignore",
			".GitAttributes",
			"a/.gitmodules",
		])
			expect(touchesGitMetadata(p), p).toBe(true);
		for (const p of ["notes.md", "github/readme.md", "digits.txt"])
			expect(touchesGitMetadata(p), p).toBe(false);
	});

	it("safeUploadName keeps one component and replaces empty/dot names", () => {
		expect(safeUploadName("report.pdf")).toBe("report.pdf");
		expect(safeUploadName("../../x/report.pdf")).toBe("report.pdf");
		expect(safeUploadName("..")).toBe("upload");
		expect(safeUploadName("")).toBe("upload");
	});

	it("containOrReply answers 400 for an escape and 404 for a missing path", () => {
		const a = fakeResponse();
		expect(containOrReply(root, "../outside/secret.txt", a.res)).toBeNull();
		expect(a.status()).toBe(400);
		const b = fakeResponse();
		expect(
			containOrReply(root, "docs/nope.md", b.res, { mustExist: true }),
		).toBeNull();
		expect(b.status()).toBe(404);
		const c = fakeResponse();
		expect(containOrReply(root, "docs/a.md", c.res)).toBe(
			join(root, "docs", "a.md"),
		);
		expect(c.status()).toBe(0);
	});

	it("addToZip skips symlinks and enforces the byte budget", async () => {
		const zip = new JSZip();
		addToZip(zip, join(root, "docs"), join(root, "docs"), {
			remaining: DOWNLOAD_ZIP_MAX_BYTES,
		});
		expect(Object.keys(zip.files).sort()).toEqual([
			"a.md",
			"blob.bin",
			"evil.svg",
			"pic.png",
		]);
		expect(() =>
			addToZip(new JSZip(), join(root, "docs"), join(root, "docs"), {
				remaining: 4,
			}),
		).toThrow(/zip limit/);
	});
});

describe("serveFileNode", () => {
	it("lists a directory with symlinks marked and never followed", async () => {
		const r = fakeResponse();
		serveFileNode(root, "docs", r.res);
		expect(r.status()).toBe(200);
		const body = JSON.parse((await r.body()).toString()) as {
			entries: { name: string; type: string; size?: number }[];
		};
		expect(
			Object.fromEntries(body.entries.map((e) => [e.name, e.type])),
		).toEqual({
			"a.md": "file",
			"alias.md": "symlink",
			"blob.bin": "file",
			"evil.svg": "file",
			"leak.txt": "symlink",
			"pic.png": "file",
		});
	});

	it("serves text and images (base64) and reports binary without content", async () => {
		const t = fakeResponse();
		serveFileNode(root, "docs/a.md", t.res);
		expect(JSON.parse((await t.body()).toString())).toMatchObject({
			type: "file",
			encoding: "text",
			content: "# A",
			truncated: false,
		});
		const i = fakeResponse();
		serveFileNode(root, "docs/pic.png", i.res);
		expect(JSON.parse((await i.body()).toString())).toMatchObject({
			encoding: "base64",
			mimeType: "image/png",
			content: Buffer.from([0x89, 0x50]).toString("base64"),
		});
		const b = fakeResponse();
		serveFileNode(root, "docs/blob.bin", b.res);
		expect(JSON.parse((await b.body()).toString())).toEqual({
			type: "file",
			name: "blob.bin",
			encoding: "binary",
		});
	});

	it("refuses symlinks out and in, traversal, and reports missing files", async () => {
		for (const [p, status] of [
			["docs/leak.txt", 400],
			["docs/alias.md", 400],
			["../outside/secret.txt", 400],
			["docs/missing.md", 404],
		] as const) {
			const r = fakeResponse();
			serveFileNode(root, p, r.res);
			expect(r.status(), p).toBe(status);
		}
	});
});

describe("handleDownload", () => {
	it("streams a file as an attachment, or inline for images", async () => {
		const a = fakeResponse();
		handleDownload(root, "/download?path=docs%2Fa.md", a.res);
		expect(a.status()).toBe(200);
		expect(a.headers()["Content-Disposition"]).toContain('filename="a.md"');
		expect((await a.body()).toString()).toBe("# A");
		const i = fakeResponse();
		handleDownload(root, "/download?path=docs%2Fpic.png&inline=1", i.res);
		expect(i.headers()["Content-Type"]).toBe("image/png");
		expect(i.headers()["Content-Disposition"]).toBeUndefined();
		expect(i.headers()["X-Content-Type-Options"]).toBe("nosniff");
		await i.body();
	});

	it("never serves an SVG inline: attachment, sandbox CSP, nosniff", async () => {
		const r = fakeResponse();
		handleDownload(root, "/download?path=docs%2Fevil.svg&inline=1", r.res);
		expect(r.status()).toBe(200);
		expect(r.headers()["Content-Type"]).toBe("image/svg+xml");
		expect(r.headers()["Content-Disposition"]).toContain("attachment");
		expect(r.headers()["Content-Security-Policy"]).toMatch(/\bsandbox\b/);
		expect(r.headers()["X-Content-Type-Options"]).toBe("nosniff");
		await r.body();
	});

	it("zips a directory without its symlinks", async () => {
		const r = fakeResponse();
		handleDownload(root, "/download?path=docs&format=zip", r.res);
		const zip = await JSZip.loadAsync(await r.body());
		expect(r.status()).toBe(200);
		expect(Object.keys(zip.files).sort()).toEqual([
			"a.md",
			"blob.bin",
			"evil.svg",
			"pic.png",
		]);
	});

	it("refuses a symlink, a traversal and a missing path", () => {
		for (const [q, status] of [
			["docs%2Fleak.txt", 400],
			["..%2Foutside%2Fsecret.txt", 400],
			["docs%2Fnope", 404],
		] as const) {
			const r = fakeResponse();
			handleDownload(root, `/download?path=${q}`, r.res);
			expect(r.status(), q).toBe(status);
		}
	});
});

describe("unreadable files", () => {
	it("serveFileNode and handleDownload answer 400 when the open itself fails", async () => {
		if (process.getuid?.() === 0) return; // root ignores mode bits
		writeFileSync(join(root, "docs", "locked.md"), "x", { mode: 0o000 });
		const s = fakeResponse();
		serveFileNode(root, "docs/locked.md", s.res);
		expect(s.status()).toBe(400);
		const d = fakeResponse();
		handleDownload(root, "/download?path=docs%2Flocked.md", d.res);
		expect(d.status()).toBe(400);
		expect((await d.body()).toString()).toMatch(/EACCES/);
	});
});
