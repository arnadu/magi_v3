/**
 * Minimal markdown → HTML, ported from the vanilla dashboard's `md()`
 * (packages/agent-runtime-worker/public/app.js). HTML is escaped FIRST, then a
 * fixed whitelist of tags (h1-3, strong, em, code, pre, ul/li, a) is
 * reintroduced from the escaped text — so raw HTML/script in the source can
 * never re-open a tag. Link hrefs are scheme-checked (http/https/mailto only)
 * so a markdown link can't become a `javascript:`/`data:` URI. No external
 * markdown dependency in this codebase; kept in sync with the dashboard's
 * renderer rather than diverging.
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

	// Only http(s)/mailto links become <a> — anything else (javascript:, data:,
	// etc.) is left as plain escaped text so a link can't execute script.
	s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label, url) =>
		/^(https?:|mailto:)/i.test(url)
			? `<a href="${url}" target="_blank" rel="noopener">${label}</a>`
			: whole,
	);

	s = s.replace(/((?:^[ \t]*[-*] .+(?:\n|$))+)/gm, (block) => {
		const items = block
			.trim()
			.split(/\n/)
			.map((line) => `<li>${line.replace(/^[ \t]*[-*] /, "")}</li>`)
			.join("");
		return `<ul>${items}</ul>`;
	});

	s = convertTables(s);

	s = s
		.split(/\n\n+/)
		.map((para) => {
			const trimmed = para.trim();
			if (!trimmed) return "";
			if (/^<(?:h[123]|pre|ul|ol|li|table)/.test(trimmed)) return trimmed;
			return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
		})
		.filter(Boolean)
		.join("");

	return s;
}

const SEPARATOR_ROW = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/;

function isTableRow(line: string): boolean {
	return line.includes("|") && line.trim().length > 0;
}

function splitTableRow(line: string): string[] {
	let t = line.trim();
	if (t.startsWith("|")) t = t.slice(1);
	if (t.endsWith("|")) t = t.slice(0, -1);
	return t.split("|").map((c) => c.trim());
}

/** left/center/right/none per column, from a GFM separator row (e.g. `:--|:-:|--:`). */
function parseAligns(sepLine: string): (string | null)[] {
	return splitTableRow(sepLine).map((cell) => {
		const left = cell.startsWith(":");
		const right = cell.endsWith(":");
		if (left && right) return "center";
		if (right) return "right";
		if (left) return "left";
		return null;
	});
}

/**
 * GFM-style tables: a header row, a `---|:--|--:` separator row, then data
 * rows — all lines containing `|`. Runs after inline formatting (bold/italic/
 * links) so cell content already carries its markup.
 */
function convertTables(s: string): string {
	const lines = s.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const sep = lines[i + 1];
		if (
			line !== undefined &&
			sep !== undefined &&
			isTableRow(line) &&
			SEPARATOR_ROW.test(sep.trim())
		) {
			const headerCells = splitTableRow(line);
			const aligns = parseAligns(sep);
			const bodyRows: string[][] = [];
			let j = i + 2;
			while (j < lines.length && isTableRow(lines[j])) {
				bodyRows.push(splitTableRow(lines[j]));
				j++;
			}
			const th = headerCells
				.map((c, ci) => {
					const align = aligns[ci];
					const style = align ? ` style="text-align:${align}"` : "";
					return `<th${style}>${c}</th>`;
				})
				.join("");
			const rows = bodyRows
				.map((r) => {
					const tds = r
						.map((c, ci) => {
							const align = aligns[ci];
							const style = align ? ` style="text-align:${align}"` : "";
							return `<td${style}>${c ?? ""}</td>`;
						})
						.join("");
					return `<tr>${tds}</tr>`;
				})
				.join("");
			out.push(
				`<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`,
			);
			i = j;
		} else {
			out.push(line);
			i++;
		}
	}
	return out.join("\n");
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
