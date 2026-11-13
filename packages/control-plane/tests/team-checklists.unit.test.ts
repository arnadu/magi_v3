/**
 * Every row of every team checklist must be a row checklist.py recognises.
 * The script counts and summarises rows by its ROW pattern; a row whose id it
 * does not match (QJ-05b, once) is silently left out of every review that
 * uses the checklist. The pattern is read from the script itself.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const TEAMS = join(ROOT, "config", "teams");
const SCRIPT = join(
	TEAMS,
	"magi-dev",
	"skills",
	"working-agreements",
	"scripts",
	"checklist.py",
);

function rowPattern(): RegExp {
	const src = readFileSync(SCRIPT, "utf8");
	const m = src.match(/ROW = re\.compile\(r"([^"]+)"\)/);
	if (!m) throw new Error("ROW pattern not found in checklist.py");
	return new RegExp(m[1]);
}

function checklistFiles(): string[] {
	const out: string[] = [];
	for (const team of readdirSync(TEAMS)) {
		const skills = join(TEAMS, team, "skills");
		if (!statSync(join(TEAMS, team)).isDirectory()) continue;
		let names: string[];
		try {
			names = readdirSync(skills);
		} catch {
			continue;
		}
		for (const skill of names) {
			const dir = join(skills, skill, "checklists");
			let files: string[];
			try {
				files = readdirSync(dir);
			} catch {
				continue;
			}
			for (const f of files) if (f.endsWith(".md")) out.push(join(dir, f));
		}
	}
	return out;
}

/** Table rows other than each table's header (the row above its separator) and the separator. */
function itemRows(text: string): string[] {
	const lines = text.split("\n");
	const isSeparator = (l: string | undefined) =>
		l !== undefined && /^\|(\s*:?-+:?\s*\|)+\s*$/.test(l);
	return lines.filter(
		(l, i) =>
			l.startsWith("|") && !isSeparator(l) && !isSeparator(lines[i + 1]),
	);
}

describe("team checklists", () => {
	const ROW = rowPattern();
	const files = checklistFiles();

	it("finds the checklists", () => {
		expect(files.length).toBeGreaterThan(5);
	});

	for (const file of files) {
		it(`${file.slice(ROOT.length + 1)}: every item is a row checklist.py counts, with a unique id`, () => {
			const rows = itemRows(readFileSync(file, "utf8"));
			const ids: string[] = [];
			for (const row of rows) {
				const m = row.match(ROW);
				expect(m, `not a checklist.py row: ${row.slice(0, 60)}`).toBeTruthy();
				if (m) ids.push(m[1]);
			}
			expect(new Set(ids).size, `duplicate ids in ${file}`).toBe(ids.length);
		});
	}
});
