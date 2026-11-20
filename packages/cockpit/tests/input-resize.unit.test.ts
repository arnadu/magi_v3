import { describe, expect, it } from "vitest";
import { MIN_INPUT_HEIGHT, nextInputHeight } from "../src/use-input-resize";

describe("nextInputHeight", () => {
	it("grows when the grip is dragged up and shrinks when dragged down", () => {
		expect(nextInputHeight(100, -50, 500)).toBe(150);
		expect(nextInputHeight(100, 30, 500)).toBe(70);
	});

	it("stays between the minimum and the maximum", () => {
		expect(nextInputHeight(100, 500, 500)).toBe(MIN_INPUT_HEIGHT);
		expect(nextInputHeight(100, -900, 500)).toBe(500);
	});
});
