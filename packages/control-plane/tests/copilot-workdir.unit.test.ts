import { describe, expect, it } from "vitest";
import { COPILOT_WORKDIR, copilotWorkdirFor } from "../src/copilot-daemon.js";

/** X-TENANT3 (2026-10-15 audit): one copilot workdir subdirectory per user. */
describe("copilotWorkdirFor", () => {
	it("gives each user's copilot a distinct directory under the shared workdir", () => {
		const a = copilotWorkdirFor("copilot-userA");
		const b = copilotWorkdirFor("copilot-userB");
		expect(a).not.toBe(b);
		expect(a.startsWith(`${COPILOT_WORKDIR}/users/`)).toBe(true);
	});

	it.each([
		"copilot-../x",
		"mission-x",
		"copilot-",
		"copilot-a/b",
	])("rejects %j rather than build a path from it", (id) => {
		expect(() => copilotWorkdirFor(id)).toThrow(/Not a copilot mission id/);
	});
});
