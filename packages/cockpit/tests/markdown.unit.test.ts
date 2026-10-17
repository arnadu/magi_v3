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
			'<a href="https://example.com/" target="_blank" rel="noopener noreferrer">x</a>',
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
			'<div class="katex-pending" data-katex-src="x^2 + y^2 = z^2" data-katex-display="true">',
		);
		expect(html).not.toContain("<p><div");
		expect(html).not.toContain("BLOCK");
	});

	it("does not treat dollar amounts as math", () => {
		const html = renderMarkdown("Price: $5.00 and $10.00 target.");
		expect(html).not.toContain("katex");
		expect(html).toContain("$5.00 and $10.00 target");
	});

	it("emits a block katex placeholder for the \\[...\\] alias, same as $$...$$", () => {
		const html = renderMarkdown("\\[x^2 + y^2 = z^2\\]");
		expect(html).toContain(
			'<div class="katex-pending" data-katex-src="x^2 + y^2 = z^2" data-katex-display="true">',
		);
	});

	it("emits an inline katex placeholder span for \\(...\\), staying inline in the sentence", () => {
		const html = renderMarkdown("heat capacity (\\( C \\)) and temperature");
		expect(html).toContain(
			'<span class="katex-pending" data-katex-src="C" data-katex-display="false">',
		);
		// Inline math must render mid-paragraph, not break the surrounding
		// text into a separate block the way a block placeholder
		// (BLOCK_TOKEN_WHOLE_RE) is allowed to.
		expect(html).toContain("<p>heat capacity (");
		expect(html).toContain(") and temperature</p>");
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

describe("renderMarkdown — attribute and scheme injection corpus (X1/XSS1)", () => {
	/**
	 * Tokenises the rendered HTML the way a browser would: every tag's
	 * attributes, honouring quotes. A quote breakout therefore surfaces as a
	 * real attribute (e.g. `onmouseover`) rather than hiding inside a value —
	 * a plain substring check can't tell the two apart.
	 */
	const attributes = (html: string) => {
		const out: Array<{ tag: string; name: string; value: string }> = [];
		const tagRe = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
		const attrRe = /([^\s=>"'/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
		for (const t of html.matchAll(tagRe)) {
			for (const a of t[2].matchAll(attrRe)) {
				out.push({
					tag: t[1].toLowerCase(),
					name: a[1].toLowerCase(),
					value: (a[2] ?? "").replace(/^["']|["']$/g, ""),
				});
			}
		}
		return out;
	};
	const decode = (v: string) =>
		v
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&");
	const assertInert = (html: string) => {
		for (const a of attributes(html)) {
			expect(a.name, html).not.toMatch(/^on/);
			expect(a.name, html).not.toBe("style");
			if (a.name === "href" || a.name === "src") {
				expect(decode(a.value), html).not.toMatch(
					/^\s*(javascript|data|vbscript|file|blob):/i,
				);
			}
		}
		expect(html).not.toMatch(/<script/i);
	};

	it("cannot break out of an href with a quote", () => {
		const html = renderMarkdown(
			'[x](https://a.example/" style="position:fixed;inset:0" onmouseover="alert(1))',
		);
		assertInert(html);
		expect(
			attributes(html)
				.filter((a) => a.tag === "a")
				.map((a) => a.name),
		).toEqual(["href", "target", "rel"]);
	});

	it("cannot break out of an image alt or src with a quote", () => {
		const html = renderMarkdown(
			'![a" onerror="alert(1)](nonexistent.png)',
			"m1",
		);
		assertInert(html);
		expect(
			attributes(html)
				.filter((a) => a.tag === "img")
				.map((a) => a.name),
		).toEqual(["src", "alt", "class"]);
		const bad = renderMarkdown('![a](x.png" onerror="alert(1))', "m1");
		assertInert(bad);
		expect(bad).not.toContain("<img");
	});

	it("refuses every script scheme spelling, including case, whitespace and entity tricks", () => {
		for (const u of [
			"javascript:alert(1)",
			"JAVASCRIPT:alert(1)",
			"java\tscript:alert(1)",
			" javascript:alert(1)",
			"&#106;avascript:alert(1)",
			"vbscript:msgbox(1)",
			"data:text/html,<script>alert(1)</script>",
			"blob:https://x/y",
			"file:///etc/passwd",
		]) {
			const html = renderMarkdown(`[click](${u})`);
			expect(html, u).not.toContain("<a ");
			assertInert(html);
		}
	});

	it("keeps legitimate links, canonicalised and with noreferrer", () => {
		const html = renderMarkdown(
			"[doc](https://example.com/a?b=1&c=2) and [m](mailto:a@b.c)",
		);
		expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
		expect(html).toContain('href="mailto:a@b.c"');
		expect(html).toContain('rel="noopener noreferrer"');
	});

	it("applies inside table cells and emphasis too", () => {
		const html = renderMarkdown(
			'| a | b |\n|---|---|\n| [x](https://e.x/" onclick="1) | **![i" onerror="1](p.png)** |',
			"m1",
		);
		assertInert(html);
		expect(html).toContain("<table>");
	});

	it("escapes quotes in plain text and code so later passes cannot reopen attributes", () => {
		expect(renderMarkdown("say \"hi\" and 'bye'")).toContain(
			"&quot;hi&quot; and &#39;bye&#39;",
		);
		expect(renderMarkdown('`a="b"`')).toContain("<code>a=&quot;b&quot;</code>");
	});
});
