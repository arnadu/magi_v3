/**
 * Every review-pipeline kind descriptor shipped in a team template compiles as Investigate
 * compiles it (ajv), so an invalid answer schema fails here rather than in the mission.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

const TEAMS = join(__dirname, "..", "..", "..", "config", "teams");

function descriptors(): string[] {
	const out: string[] = [];
	for (const team of readdirSync(TEAMS, { withFileTypes: true })) {
		if (!team.isDirectory()) continue;
		const skills = join(TEAMS, team.name, "skills");
		let names: string[] = [];
		try {
			names = readdirSync(skills);
		} catch {
			continue;
		}
		for (const skill of names) {
			const kinds = join(skills, skill, "kinds");
			try {
				for (const f of readdirSync(kinds))
					if (f.endsWith(".json")) out.push(join(kinds, f));
			} catch {
				// a skill without kinds
			}
		}
	}
	return out;
}

describe("review-pipeline kind descriptors in team templates", () => {
	const files = descriptors();
	it("exist", () => expect(files.length).toBeGreaterThan(0));
	it.each(
		files,
	)("%s has a schema ajv compiles, requiring evidence with file, line and quote", (f) => {
		const d = JSON.parse(readFileSync(f, "utf8"));
		expect(() => new Ajv({ strict: false }).compile(d.schema)).not.toThrow();
		const ev = d.schema.properties[d.evidence_field ?? "evidence"];
		expect(ev.items.required).toEqual(
			expect.arrayContaining(["file", "line", "quote"]),
		);
	});
});
