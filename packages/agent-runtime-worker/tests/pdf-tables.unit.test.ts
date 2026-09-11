import { describe, expect, it } from "vitest";
import { reconstructPageText, type StextLine } from "../src/pdf-tables.js";

/** Shorthand for a line at (x, y) — w/h are irrelevant to the algorithm. */
function line(text: string, x: number, y: number): StextLine {
	return { text, x, y, w: 100, h: 12 };
}

describe("reconstructPageText", () => {
	it("leaves normal prose (one line per y) untouched, in reading order", () => {
		const lines = [
			line("First paragraph line one.", 82, 100),
			line("First paragraph line two.", 82, 113),
			line("Second paragraph starts here.", 82, 140),
		];
		const out = reconstructPageText(lines);
		expect(out).not.toContain("| ---");
		expect(out.split("\n")).toEqual([
			"First paragraph line one.",
			"First paragraph line two.",
			"Second paragraph starts here.",
		]);
	});

	it("reconstructs a clean multi-row table (rows at consistent column x)", () => {
		const lines = [
			line("Variable", 87, 374),
			line("Estimate", 250, 374),
			line("P-value", 406, 374),
			line("Intercept", 87, 387),
			line("12.12", 250, 387),
			line("<.01", 406, 387),
			line("Coupon", 87, 400),
			line("0.45", 250, 400),
			line("0.47", 406, 400),
		];
		const out = reconstructPageText(lines);
		expect(out).toBe(
			[
				"| Variable | Estimate | P-value |",
				"| --- | --- | --- |",
				"| Intercept | 12.12 | <.01 |",
				"| Coupon | 0.45 | 0.47 |",
			].join("\n"),
		);
	});

	it("folds a wrapped (multi-line) cell into the row it belongs to, at most once", () => {
		// Mirrors the real exam PDF: "Definition" cell wraps onto a second line
		// at the same x, one line-height below, with no other cell on that row.
		const lines = [
			line("Variable", 87, 156),
			line("Definition", 222, 156),
			line("Average", 406, 156),
			line("Online advertisingt", 87, 169),
			line("Total spending in pounds on online", 222, 169),
			line("83,520.30", 406, 169),
			line("advertising in week t", 222, 182), // continuation of the Definition cell above
			line("Offline advertisingt", 87, 195),
			line("Total spending in pounds on offline", 222, 195),
			line("22,730.45", 406, 195),
		];
		const out = reconstructPageText(lines);
		expect(out).toBe(
			[
				"| Variable | Definition | Average |",
				"| --- | --- | --- |",
				"| Online advertisingt | Total spending in pounds on online advertising in week t | 83,520.30 |",
				"| Offline advertisingt | Total spending in pounds on offline | 22,730.45 |",
			].join("\n"),
		);
	});

	it("does not force table syntax onto a single coincidental 2-cell row", () => {
		const lines = [
			line("Left label", 82, 100),
			line("Right label", 400, 100), // only occurs once — never repeats/confirms as a table
			line("Normal paragraph text follows.", 82, 130),
		];
		const out = reconstructPageText(lines);
		expect(out).not.toContain("| ---");
		expect(out).toContain("Left label  Right label");
		expect(out).toContain("Normal paragraph text follows.");
	});

	it("ignores blank/whitespace-only lines without corrupting table or prose detection", () => {
		const lines = [
			line("Variable", 87, 156),
			line("Value", 406, 156),
			line(" ", 82, 163), // blank spacer line between header and first row
			line("Alpha", 87, 169),
			line("1", 406, 169),
			line("", 82, 182), // another blank spacer, x coincidentally near column 1
			line("This paragraph must not be swallowed into the table.", 82, 200),
		];
		const out = reconstructPageText(lines);
		expect(out).toBe(
			[
				"| Variable | Value |",
				"| --- | --- |",
				"| Alpha | 1 |",
				"",
				"This paragraph must not be swallowed into the table.",
			].join("\n"),
		);
	});

	it("does not extend a table match across a real column-x drift beyond tolerance", () => {
		const lines = [
			line("Variable", 87, 156),
			line("Value", 406, 156),
			line("Alpha", 87, 169),
			line("1", 406, 169),
			// Second "row" starts 40pt to the right of the established column 1 —
			// a genuinely different layout, not the same table continuing.
			line("Unrelated", 127, 300),
			line("2", 446, 300),
		];
		const out = reconstructPageText(lines);
		const tableCount = (out.match(/\| --- \|/g) ?? []).length;
		expect(tableCount).toBe(1);
		expect(out).toContain("Unrelated");
	});

	it("escapes a literal pipe character inside a cell", () => {
		const lines = [
			line("A | B", 87, 156),
			line("Value", 406, 156),
			line("Row", 87, 169),
			line("1", 406, 169),
		];
		const out = reconstructPageText(lines);
		expect(out).toContain("A \\| B");
	});

	it("returns an empty string for an empty (scanned) page", () => {
		expect(reconstructPageText([])).toBe("");
	});
});
