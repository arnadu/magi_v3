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

	it("emits a katex placeholder div for $$...$$ block math, not <p>-wrapped", () => {
		const html = renderMarkdown("$$x^2 + y^2 = z^2$$");
		expect(html).toContain(
			'<div class="katex-pending" data-katex-src="x^2 + y^2 = z^2">',
		);
		expect(html).not.toContain("<p><div");
		expect(html).not.toContain("BLOCK");
	});

	it("does not treat dollar amounts as math", () => {
		const html = renderMarkdown("Price: $5.00 and $10.00 target.");
		expect(html).not.toContain("katex");
		expect(html).toContain("$5.00 and $10.00 target");
	});

	it("emits a mermaid placeholder div with the escaped source, not <p>-wrapped", () => {
		const md = "```mermaid\ngraph TD; A-->B;\n```";
		const html = renderMarkdown(md);
		expect(html).toContain(
			'<div class="mermaid" data-mermaid-src="graph TD; A--&gt;B;">',
		);
		expect(html).not.toContain("<p><div");
		expect(html).not.toContain("BLOCK");
	});

	it("does not confuse a mermaid block with a plain fenced code block", () => {
		const html = renderMarkdown("```js\nconst x = 1;\n```");
		expect(html).toContain("<pre><code>const x = 1;</code></pre>");
		expect(html).not.toContain("mermaid");
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
