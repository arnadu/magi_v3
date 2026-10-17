import { describe, expect, it } from "vitest";
import { validateDraft } from "../src/DraftMissionFields";

describe("validateDraft", () => {
	it("refuses duplicate agent ids, naming each once", () => {
		const r = validateDraft(
			[{ id: "a" }, { id: "b" }, { id: "a" }, { id: "a" }],
			{
				maxCostUsd: "",
			},
		);
		expect(r).toEqual({ error: "Agent ids must be unique: a" });
	});
	it("treats a blank cap as 'use the default' and parses a positive one", () => {
		expect(validateDraft([{ id: "a" }], { maxCostUsd: " " })).toEqual({
			maxCostUsd: undefined,
		});
		expect(validateDraft([{ id: "a" }], { maxCostUsd: "40" })).toEqual({
			maxCostUsd: 40,
		});
	});
	it("refuses zero, negative and non-numeric caps", () => {
		for (const bad of ["0", "-5", "ten"]) {
			expect(validateDraft([{ id: "a" }], { maxCostUsd: bad })).toHaveProperty(
				"error",
			);
		}
	});
});
