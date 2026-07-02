import { describe, expect, it } from "vitest";
import { parseCsv, renderMarkdown } from "../src/markdown";

describe("renderMarkdown", () => {
	it("renders a GFM table with alignment", () => {
		const md = ["| A | B | C |", "|---|:--:|--:|", "| 1 | 2 | 3 |"].join("\n");
		const html = renderMarkdown(md);
		expect(html).toContain("<table>");
		expect(html).toContain("<th>A</th>");
		expect(html).toContain('<th style="text-align:center">B</th>');
		expect(html).toContain('<th style="text-align:right">C</th>');
		expect(html).toContain("<td>1</td>");
	});

	it("does not wrap a table in a <p>", () => {
		const md = ["| A |", "|---|", "| 1 |"].join("\n");
		expect(renderMarkdown(md)).not.toContain("<p><table>");
	});

	it("leaves non-table pipe text alone", () => {
		expect(renderMarkdown("a | b")).toContain("a | b");
	});

	it("links http(s)/mailto URLs", () => {
		expect(renderMarkdown("[x](https://example.com)")).toContain(
			'<a href="https://example.com" target="_blank" rel="noopener">x</a>',
		);
		expect(renderMarkdown("[x](mailto:a@b.com)")).toContain("<a href=");
	});

	it("does not turn a javascript: URL into a link", () => {
		const html = renderMarkdown("[x](javascript:alert(1))");
		expect(html).not.toContain("<a ");
		expect(html).toContain("javascript:alert(1)");
	});

	it("does not turn a data: URL into a link", () => {
		const html = renderMarkdown("[x](data:text/html,evil)");
		expect(html).not.toContain("<a ");
	});
});

describe("parseCsv", () => {
	it("parses quoted fields with embedded commas and quotes", () => {
		const rows = parseCsv('a,"b,c","d""e"\n1,2,3');
		expect(rows).toEqual([
			["a", "b,c", 'd"e'],
			["1", "2", "3"],
		]);
	});
});
