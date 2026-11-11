import { describe, expect, it } from "vitest";
import { changedMentalMaps } from "../src/mental-map-diff";

describe("changedMentalMaps", () => {
	it("returns nothing when no map was edited", () => {
		const loaded = { a: "<p>1</p>", b: "<p>2</p>" };
		expect(changedMentalMaps({ ...loaded }, loaded)).toEqual({});
	});
	it("returns only the maps that differ from what was loaded", () => {
		expect(
			changedMentalMaps(
				{ a: "<p>1</p>", b: "<p>edited</p>" },
				{ a: "<p>1</p>", b: "<p>2</p>" },
			),
		).toEqual({ b: "<p>edited</p>" });
	});
	it("treats a map absent from the loaded set as changed", () => {
		expect(changedMentalMaps({ c: "<p>new</p>" }, {})).toEqual({
			c: "<p>new</p>",
		});
	});
});
