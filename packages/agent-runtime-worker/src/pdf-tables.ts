/**
 * Reconstructs a PDF page's text as Markdown, upgrading tabular regions into real
 * Markdown tables instead of mupdf's flat reading-order dump. ADR-0028 has the
 * full rationale and how this fits alongside OCR/image-text transcription.
 *
 * Investigated live: `page.toStructuredText().asText()` returns table cells as a
 * linear sequence ("Variable Definition Average Online advertisingt Total
 * spending...") with no row/column structure — not wrong, just unstructured,
 * leaving row/column reassembly to whoever reads it. mupdf's structured-text
 * JSON (`asJSON()`) gives each line's bounding box, which is enough geometry to
 * reconstruct the grid ourselves: mupdf's own "block" grouping does NOT align
 * with logical table rows (verified against a real exam PDF — a data column's
 * numeric value routinely lands in a different block than its row's label), but
 * individual *lines* carry accurate x/y positions across the whole page, so
 * detection works on the flat set of lines, not mupdf's block boundaries.
 *
 * Pure geometry, no mupdf/PDF dependency in the algorithm itself — takes plain
 * {text,x,y,w,h} lines, fully unit-testable with synthetic layouts.
 */

export interface StextLine {
	text: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Lines within this many points of each other vertically are "the same row." */
const ROW_Y_TOLERANCE = 2;
/** A candidate table row's cell x-positions must match the table's reference
 * row within this many points to count as the same column. */
const COLUMN_X_TOLERANCE = 10;
/** A wrapped-cell continuation line must follow its row within this many points
 * vertically — bounds how far a false-positive column-x match (e.g. a blank
 * spacer line coincidentally left-aligned with column 1) can reach before this
 * stops treating unrelated content below the table as more of the table. */
const MAX_CONTINUATION_GAP = 25;

interface RowBand {
	y: number;
	cells: StextLine[]; // sorted by x; mutated in place to absorb continuations
	continued: boolean; // at most one continuation line absorbed per row
}

function groupIntoRows(lines: StextLine[]): RowBand[] {
	const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
	const rows: RowBand[] = [];
	for (const line of sorted) {
		const last = rows[rows.length - 1];
		if (last && Math.abs(line.y - last.y) <= ROW_Y_TOLERANCE) {
			last.cells.push(line);
			last.cells.sort((a, b) => a.x - b.x);
		} else {
			rows.push({ y: line.y, cells: [line], continued: false });
		}
	}
	return rows;
}

/** Compares candidate cell x-positions against a table's reference (first) row. */
function columnsMatch(reference: StextLine[], candidate: StextLine[]): boolean {
	if (reference.length !== candidate.length) return false;
	return reference.every(
		(cell, i) => Math.abs(cell.x - candidate[i].x) <= COLUMN_X_TOLERANCE,
	);
}

/** Which reference column (if any) a single stray line's x-position belongs to. */
function matchingColumn(reference: StextLine[], line: StextLine): number {
	return reference.findIndex(
		(cell) => Math.abs(cell.x - line.x) <= COLUMN_X_TOLERANCE,
	);
}

function escapeCell(text: string): string {
	return text.trim().replace(/\|/g, "\\|") || " ";
}

function renderTable(rows: RowBand[]): string {
	const line = (cells: StextLine[]) =>
		`| ${cells.map((c) => escapeCell(c.text)).join(" | ")} |`;
	const sepLine = `| ${rows[0].cells.map(() => "---").join(" | ")} |`;
	return [
		line(rows[0].cells),
		sepLine,
		...rows.slice(1).map((r) => line(r.cells)),
	].join("\n");
}

/**
 * Reassembles a page's lines into Markdown: a contiguous run of ≥2 rows with
 * ≥2 cells each, sharing consistent column x-positions, becomes a Markdown
 * table; everything else is emitted as plain lines, unchanged in content and
 * order from mupdf's own reading order. A single-cell row immediately
 * following an active table row, at an x matching one of that table's
 * columns, is folded into that cell as a wrapped-line continuation (at most
 * one per row — see MAX_CONTINUATION_GAP) rather than breaking the table.
 */
export function reconstructPageText(lines: StextLine[]): string {
	const meaningful = lines.filter((l) => l.text.trim().length > 0);
	const rows = groupIntoRows(meaningful);

	const out: string[] = [];
	let i = 0;
	while (i < rows.length) {
		const row = rows[i];
		if (row.cells.length < 2) {
			out.push(row.cells[0].text.trim());
			i++;
			continue;
		}

		const tableRows: RowBand[] = [row];
		let j = i + 1;
		while (j < rows.length) {
			const next = rows[j];
			const last = tableRows[tableRows.length - 1];
			if (
				next.cells.length >= 2 &&
				columnsMatch(tableRows[0].cells, next.cells)
			) {
				tableRows.push(next);
				j++;
				continue;
			}
			if (
				next.cells.length === 1 &&
				!last.continued &&
				next.y - last.y <= MAX_CONTINUATION_GAP
			) {
				const colIndex = matchingColumn(tableRows[0].cells, next.cells[0]);
				if (colIndex !== -1) {
					last.cells[colIndex].text =
						`${last.cells[colIndex].text.trim()} ${next.cells[0].text.trim()}`.trim();
					last.continued = true;
					j++;
					continue;
				}
			}
			break;
		}

		if (tableRows.length >= 2) {
			out.push("", renderTable(tableRows), "");
			i = j;
		} else {
			// Only one multi-cell row, nothing confirmed it's really a table —
			// not confident enough to force Markdown table syntax onto a single
			// row; preserve the content, left to right, without inventing structure.
			out.push(row.cells.map((c) => c.text.trim()).join("  "));
			i++;
		}
	}
	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
