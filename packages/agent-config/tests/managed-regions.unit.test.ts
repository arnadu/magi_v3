import { describe, expect, it } from "vitest";
import { entryTrigger } from "../src/baseline/entry-tag.js";
import { AgentSchema, ManagedRegionSchema } from "../src/loader.js";

const agent = (managedRegions: unknown) => ({
	id: "code-reviewer",
	supervisor: "user",
	systemPrompt: "Review code.",
	initialMentalMap: "<section></section>",
	managedRegions,
});

describe("managedRegions", () => {
	it("accepts a region filled from a file in the shared folder", () => {
		const a = AgentSchema.parse(
			agent([
				{
					key: "scan-todo",
					file: "analysis/todo-code-reviewer.md",
					maxBytes: 6000,
				},
			]),
		);
		expect(a.managedRegions?.[0].file).toBe("analysis/todo-code-reviewer.md");
	});

	it("refuses a path out of the shared folder, the objectives key, and unknown fields", () => {
		for (const r of [
			{ key: "x", file: "a/../../etc/passwd" },
			{ key: "x", file: "/etc/passwd" },
			{ key: "my-objectives", file: "a.md" },
			{ key: "x", file: "a.md", maxBytes: 50_000 },
			{ key: "x", file: "a.md", extra: true },
		])
			expect(ManagedRegionSchema.safeParse(r).success, JSON.stringify(r)).toBe(
				false,
			);
	});

	it("refuses two regions with the same key, and more than four", () => {
		const r = { key: "scan-todo", file: "a.md" };
		expect(AgentSchema.safeParse(agent([r, r])).success).toBe(false);
		const five = Array.from({ length: 5 }, (_, i) => ({
			key: `r${i}`,
			file: "a.md",
		}));
		expect(AgentSchema.safeParse(agent(five)).success).toBe(false);
	});
});

describe("entryTrigger", () => {
	it("returns the callback it tags, unchanged", () => {
		const tick = () => 42;
		expect(entryTrigger("schedule.deliver", tick)).toBe(tick);
	});
});
