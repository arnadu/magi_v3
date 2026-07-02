/**
 * Minimal markdown → HTML, ported from the vanilla dashboard's `md()`
 * (packages/agent-runtime-worker/public/app.js). HTML is escaped FIRST, then a
 * fixed whitelist of tags (h1-3, strong, em, code, pre, ul/li, a) is
 * reintroduced from the escaped text — so raw HTML/script in the source can
 * never re-open a tag. No external markdown dependency in this codebase; kept
 * in sync with the dashboard's renderer rather than diverging.
 */
export function renderMarkdown(text: string): string {
	if (!text) return "";
	let s = String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

	s = s.replace(
		/```[^\n]*\n([\s\S]*?)```/g,
		(_, code) => `<pre><code>${code.trimEnd()}</code></pre>`,
	);
	s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");

	s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>");
	s = s.replace(/^## (.+)$/gm, "<h2>$1</h2>");
	s = s.replace(/^# (.+)$/gm, "<h1>$1</h1>");

	s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
	s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");

	s = s.replace(
		/\[([^\]]+)\]\(([^)]+)\)/g,
		'<a href="$2" target="_blank" rel="noopener">$1</a>',
	);

	s = s.replace(/((?:^[ \t]*[-*] .+(?:\n|$))+)/gm, (block) => {
		const items = block
			.trim()
			.split(/\n/)
			.map((line) => `<li>${line.replace(/^[ \t]*[-*] /, "")}</li>`)
			.join("");
		return `<ul>${items}</ul>`;
	});

	s = s
		.split(/\n\n+/)
		.map((para) => {
			const trimmed = para.trim();
			if (!trimmed) return "";
			if (/^<(?:h[123]|pre|ul|ol|li)/.test(trimmed)) return trimmed;
			return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
		})
		.filter(Boolean)
		.join("");

	return s;
}

/** Small, dependency-free CSV parser (handles quoted fields with commas/escaped quotes). */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += c;
			}
		} else if (c === '"') {
			inQuotes = true;
		} else if (c === ",") {
			row.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			field = "";
			rows.push(row);
			row = [];
		} else {
			field += c;
		}
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}
