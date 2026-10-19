/** Runtime half of stored/paths.ts; the compile-time half is type-tests/paths.ts. */
import { describe, expect, it } from "vitest";
import { field, ref } from "../src/index.js";

interface Doc {
	usage: { cost: { totalCostUsd: number } };
}

describe("stored paths", () => {
	it("field returns the path unchanged", () => {
		expect(field<Doc>()("usage.cost.totalCostUsd")).toBe(
			"usage.cost.totalCostUsd",
		);
	});
	it("ref prefixes the path with $", () => {
		expect(ref<Doc>()("usage.cost")).toBe("$usage.cost");
	});
});
