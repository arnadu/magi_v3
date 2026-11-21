import { describe, expect, it } from "vitest";
import { openAppParam, withoutOpenAppParam } from "../src/open-app-param";

const CAP = "0123456789abcdef0123456789abcdef";

describe("openAppParam", () => {
	it("reads a 32-hex capability and nothing else", () => {
		expect(openAppParam(`?openApp=${CAP}`)).toBe(CAP);
		expect(openAppParam(`?x=1&openApp=${CAP}`)).toBe(CAP);
		expect(openAppParam("?openApp=../../etc")).toBeNull();
		expect(openAppParam(`?openApp=${CAP.toUpperCase()}`)).toBeNull();
		expect(openAppParam("")).toBeNull();
	});

	it("removes the parameter and keeps the rest", () => {
		expect(withoutOpenAppParam(`https://c.example/?openApp=${CAP}&x=1`)).toBe(
			"https://c.example/?x=1",
		);
	});
});
