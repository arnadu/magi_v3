import { describe, expect, it } from "vitest";
import { validateNewMissionId } from "../src/mission-id.js";

/** MID1 (2026-10-15 audit): the copilot-namespace collision and id squatting. */
describe("validateNewMissionId", () => {
	it.each([
		"copilot-admin",
		"copilot-abc123",
		"copilot",
		"admin",
		"platform-x",
		"system",
	])("rejects the reserved id %s", (id) => {
		expect(() => validateNewMissionId(id)).toThrow(/reserved/);
	});

	it.each([
		"../x",
		"Copilot-Admin",
		"has space",
		"ab",
		"-leading-hyphen",
		"a".repeat(42),
		"",
	])("rejects the malformed id %j", (id) => {
		expect(() => validateNewMissionId(id)).toThrow(/missionId must be/);
	});

	it("rejects a non-string", () => {
		expect(() => validateNewMissionId(42)).toThrow(/missionId must be/);
	});

	it.each([
		"meteo-textbook-20260730",
		"general-assistant-20260602-d204",
		"tutor",
		"test2",
		"copilotish-research",
		"admins-guide",
	])("accepts the normal id %s", (id) => {
		expect(() => validateNewMissionId(id)).not.toThrow();
	});
});
