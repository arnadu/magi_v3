import { describe, expect, it } from "vitest";
import { availableSkills } from "../src/available-skills";

describe("availableSkills", () => {
	it("platform skills plus the mission's own skills/<name>/SKILL.md, without duplicates", () => {
		expect(
			availableSkills(
				["data-factory", "run-background"],
				[
					{ path: "skills/report-format/SKILL.md" },
					{ path: "skills/data-factory/SKILL.md" },
					{ path: "skills/report-format/template.md" },
					{ path: "goals.json" },
				],
			),
		).toEqual(["data-factory", "run-background", "report-format"]);
	});
});
