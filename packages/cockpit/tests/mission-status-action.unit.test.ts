import { describe, expect, it } from "vitest";
import { statusAction } from "../src/mission-status-action";

describe("statusAction", () => {
	it("offers Resume for a suspended mission and for one in error", () => {
		expect(statusAction("running")).toBe("suspend");
		expect(statusAction("suspended")).toBe("resume");
		expect(statusAction("error")).toBe("resume");
	});

	it("offers nothing mid-transition, once destroyed, or when unknown", () => {
		for (const s of ["provisioning", "destroyed", "draft", null, undefined]) {
			expect(statusAction(s)).toBeNull();
		}
	});
});
