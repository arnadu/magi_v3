import { describe, expect, it } from "vitest";
import { liveStateToStatus } from "../src/missions.js";

describe("liveStateToStatus", () => {
	it("maps started/starting to running", () => {
		expect(liveStateToStatus("started")).toBe("running");
		expect(liveStateToStatus("starting")).toBe("running");
	});

	it("maps stopped/stopping to suspended", () => {
		expect(liveStateToStatus("stopped")).toBe("suspended");
		expect(liveStateToStatus("stopping")).toBe("suspended");
	});

	it("maps destroyed/destroying to destroyed", () => {
		expect(liveStateToStatus("destroyed")).toBe("destroyed");
		expect(liveStateToStatus("destroying")).toBe("destroyed");
	});

	it("returns null (leave status unchanged) for transient creation states, not error", () => {
		// provisionMission/resumeMission return as soon as Fly accepts the
		// create/start call, so a just-provisioned machine can still be in one
		// of these states on the cockpit's first GET /:id — mapping them to
		// "error" flipped brand-new, fully-provisioned missions to error within
		// seconds (found live, 2026-09-11).
		expect(liveStateToStatus("created")).toBeNull();
		expect(liveStateToStatus("replacing")).toBeNull();
	});

	it("returns null for any other unrecognized state, rather than assuming error", () => {
		expect(liveStateToStatus("some-future-fly-state")).toBeNull();
	});
});
