import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CHROMIUM_POLICY_PATH,
	chromiumPolicyProblem,
} from "../src/tools/browse-web.js";

const shipped = readFileSync(
	join(__dirname, "..", "chromium-policy.json"),
	"utf8",
);

describe("Chromium URL blocklist policy (F-044)", () => {
	it("the policy shipped in the image blocks file:// and chrome://", () => {
		expect(chromiumPolicyProblem(() => shipped)).toBeNull();
	});
	it("reports a missing or incomplete policy so BrowseWeb fails closed", () => {
		expect(
			chromiumPolicyProblem(() => {
				throw new Error("ENOENT");
			}),
		).toMatch(/missing or unreadable/);
		expect(
			chromiumPolicyProblem(() =>
				JSON.stringify({ URLBlocklist: ["file://*"] }),
			),
		).toMatch(/does not block chrome:\/\/\*/);
	});
	it("names the directory Chrome for Testing reads", () => {
		expect(CHROMIUM_POLICY_PATH).toBe(
			"/etc/opt/chrome_for_testing/policies/managed/magi.json",
		);
	});
});
