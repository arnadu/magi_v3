import { describe, expect, it } from "vitest";
import { ceilingRangeText } from "../src/LimitsPanel";

describe("ceilingRangeText", () => {
	it("tells a platform admin they can set any amount, with the current ceiling first", () => {
		const t = ceilingRangeText(1000, 100, true);
		expect(t).toMatch(
			/^Currently \$1,000\.00\. As a platform admin you can set any amount/,
		);
	});
	it("tells a non-admin above-platform ceiling they can only lower it", () => {
		expect(ceilingRangeText(1000, 100, false)).toMatch(
			/Currently \$1,000\.00, set by a platform admin.*You can lower it; only a platform admin can raise it\./,
		);
	});
	it("states the platform ceiling as the maximum for a non-admin under it", () => {
		expect(ceilingRangeText(50, 100, false)).toBe(
			"Currently $50.00. You can raise it to at most $100.00 (the platform ceiling); a platform admin can go higher.",
		);
	});
});
