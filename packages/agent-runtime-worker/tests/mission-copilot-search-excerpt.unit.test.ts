import { describe, expect, it } from "vitest";
import { matchExcerpt } from "../src/mission-copilot-monitoring-tools.js";

describe("SearchMissionHistory excerpts (MC5)", () => {
	it("returns the text around a match in string content, case-insensitively", () => {
		const text = `${"a".repeat(300)} the COMEX close was 2,410 ${"b".repeat(300)}`;
		const excerpt = matchExcerpt(
			{ role: "user", content: text },
			"comex close",
		);
		expect(excerpt).toContain("the COMEX close was 2,410");
		expect(excerpt.startsWith("…")).toBe(true);
		expect(excerpt.endsWith("…")).toBe(true);
		expect(excerpt.length).toBeLessThan(400);
	});

	it("searches the text blocks of array content", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "toolCall", name: "Bash" },
				{ type: "text", text: "Gold closed above the 200-day average." },
			],
		};
		expect(matchExcerpt(message, "200-day")).toBe(
			"Gold closed above the 200-day average.",
		);
	});

	it("is empty when the match is not in the message text", () => {
		expect(
			matchExcerpt({ role: "user", content: "nothing here" }, "gold"),
		).toBe("");
	});
});
