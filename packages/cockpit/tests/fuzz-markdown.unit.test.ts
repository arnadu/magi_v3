/**
 * Property-based fuzzing (security assurance plan, part 4) of the cockpit's markdown renderer,
 * which renders agent-written text (and through it, web content) in the operator's session.
 * Whatever the markdown, the DOM it produces holds no script, no event handler, no dangerous URL
 * and no style beyond table alignment. Checked on the parsed DOM (jsdom, scripts off), not on the
 * HTML string, so a payload that only becomes dangerous once parsed is still caught.
 * Fixed seed; FAST_CHECK_SEED=<n> explores elsewhere.
 */
import fc from "fast-check";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown";

const RUNS = {
	seed: Number(process.env.FAST_CHECK_SEED ?? 20261124),
	numRuns: 600,
};

const FORBIDDEN_TAGS = new Set([
	"SCRIPT",
	"IFRAME",
	"OBJECT",
	"EMBED",
	"BASE",
	"FORM",
	"META",
	"LINK",
	"STYLE",
	"FRAME",
	"FRAMESET",
]);
const URL_ATTRS = [
	"href",
	"src",
	"xlink:href",
	"action",
	"formaction",
	"srcset",
	"poster",
	"background",
];

// One document, reused: a new JSDOM per input costs ~7 ms. Scripts never run (jsdom's default).
const DOM = new JSDOM("<body></body>");

/** What makes the rendered HTML unsafe, or null. */
function unsafe(html: string): string | null {
	const doc = DOM.window.document;
	doc.body.innerHTML = html;
	for (const el of Array.from(doc.body.querySelectorAll("*"))) {
		if (FORBIDDEN_TAGS.has(el.tagName.toUpperCase())) return `<${el.tagName}>`;
		for (const a of Array.from(el.attributes)) {
			const name = a.name.toLowerCase();
			if (name.startsWith("on")) return `${el.tagName} ${name}=`;
			if (name === "style" && !/^text-align:(left|center|right)$/.test(a.value))
				return `style="${a.value}"`;
			if (URL_ATTRS.includes(name)) {
				// What a browser would resolve: entities are already decoded by the parser.
				const v = [...a.value]
					.filter((ch) => {
						const c = ch.codePointAt(0) ?? 0;
						return c > 0x20 && !(c >= 0x7f && c <= 0x9f);
					})
					.join("")
					.toLowerCase();
				if (/^(javascript|vbscript|data|file|blob):/.test(v))
					return `${name}="${a.value}"`;
			}
		}
	}
	return null;
}

const fragment = fc.constantFrom(
	"<script>alert(1)</script>",
	"<img src=x onerror=alert(1)>",
	"<svg/onload=alert(1)>",
	'<a href="javascript:alert(1)">x</a>',
	"<iframe src=//evil></iframe>",
	"<style>*{}</style>",
	"[x](javascript:alert(1))",
	"[x](JaVaScRiPt:alert(1))",
	"[x](java\tscript:alert(1))",
	"[x](&#106;avascript:alert(1))",
	"[x](javascript&#58;alert(1))",
	"[x](data:text/html;base64,PHNjcmlwdD4=)",
	"[x]( javascript:alert(1))",
	'[a](https://a" onmouseover="alert(1))',
	"[a](https://a' onmouseover='alert(1))",
	"[a](https://example.com)",
	"[m](mailto:a@b.c)",
	'![i](x" onerror="alert(1))',
	"![i](javascript:alert(1))",
	"![i](//evil/x.png)",
	"![i](https://evil/x.png)",
	"![i](images/chart.png)",
	'![a" onerror="alert(1)](images/chart.png)',
	"![a' onerror='alert(1)](images/chart.png)",
	'![i](images/chart.png "t" onerror="alert(1)")',
	'[a" onclick="x](https://example.com)',
	'[a](https://example.com/?q=" onclick="x)',
	"![i](../../etc/passwd)",
	"`<script>x</script>`",
	"```\n<script>x</script>\n```",
	'```mermaid\ngraph TD; A-->B; click A callback\n"><img src=x onerror=1>\n```',
	"| a | b |\n|---|:-:|\n| <img src=x onerror=1> | [x](javascript:1) |",
	"**bold** _it_ ~~s~~",
	"# Title\n",
	"> quote <b onclick=1>x</b>",
	"- item\n- [x](vbscript:msgbox)",
	"&lt;script&gt;",
	"&#60;script&#62;alert(1)&#60;/script&#62;",
	'"',
	"'",
	"<",
	">",
	"&",
	"\n",
	"\n\n",
	" ",
	"](",
	"[",
	")",
	"`",
);

describe("rendered markdown never carries a script, an event handler or a dangerous URL", () => {
	it("for any mix of HTML, link and image tricks, fences and tables", () => {
		const doc = fc.array(
			fc.oneof(
				{ arbitrary: fragment, weight: 5 },
				{ arbitrary: fc.string({ maxLength: 8 }), weight: 1 },
			),
			{
				minLength: 1,
				maxLength: 12,
			},
		);
		let links = 0;
		fc.assert(
			fc.property(
				doc,
				fc.constantFrom(undefined, "m-1"),
				(parts, missionId) => {
					const html = renderMarkdown(
						parts.join(""),
						missionId,
						missionId ? "reports" : undefined,
					);
					if (html.includes("<a ")) links++;
					const why = unsafe(html);
					if (why)
						throw new Error(
							`unsafe output (${why}) from ${JSON.stringify(parts.join(""))}`,
						);
					return true;
				},
			),
			RUNS,
		);
		expect(links).toBeGreaterThan(0);
	}, 60_000);

	it("the oracle itself catches each kind of unsafe output", () => {
		for (const bad of [
			"<script>1</script>",
			"<img src=x onerror=1>",
			'<a href="javascript:1">x</a>',
			'<a href="&#106;avascript:1">x</a>',
			'<a href="java&#9;script:1">x</a>',
			'<img src="data:image/svg+xml,x">',
			'<p style="color:red">x</p>',
			"<iframe></iframe>",
		]) {
			expect(unsafe(bad), bad).not.toBeNull();
		}
		expect(
			unsafe(
				'<a href="https://example.com">x</a><td style="text-align:center">y</td>',
			),
		).toBeNull();
	});
});
