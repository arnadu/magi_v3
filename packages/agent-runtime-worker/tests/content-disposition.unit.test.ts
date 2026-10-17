import { describe, expect, it } from "vitest";
import { contentDisposition } from "../src/monitor-files.js";

describe("contentDisposition (RFC 6266)", () => {
	it("keeps a plain ASCII name as a single quoted filename", () => {
		expect(contentDisposition("report.md")).toBe(
			'attachment; filename="report.md"',
		);
	});

	it("adds an encoded filename* for non-Latin-1 names and keeps the header Latin-1 safe", () => {
		const h = contentDisposition("rapport été – 日本.pdf");
		expect(h.startsWith('attachment; filename="rapport _t_ _ __.pdf"')).toBe(
			true,
		);
		expect(h).toContain("filename*=UTF-8''rapport%20%C3%A9t%C3%A9");
		// Every byte of the header value must be Latin-1 for Node to accept it.
		expect([...h].every((c) => c.charCodeAt(0) < 256)).toBe(true);
	});

	it("neutralises quotes, backslashes and line breaks in the fallback", () => {
		const h = contentDisposition('a"b\\c\r\nd.txt');
		expect(h).toMatch(/^attachment; filename="a_b_cd\.txt"/);
		expect(h).not.toContain("\n");
	});

	it("never produces an empty fallback name", () => {
		expect(contentDisposition("")).toBe('attachment; filename="download"');
	});
});
