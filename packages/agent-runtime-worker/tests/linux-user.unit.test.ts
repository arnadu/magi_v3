import { afterEach, describe, expect, it } from "vitest";
import { resolveLinuxUsers } from "../src/linux-user.js";

describe("resolveLinuxUsers", () => {
	const ORIGINAL_POOL_SIZE = process.env.MAGI_POOL_SIZE;
	afterEach(() => {
		if (ORIGINAL_POOL_SIZE === undefined) delete process.env.MAGI_POOL_SIZE;
		else process.env.MAGI_POOL_SIZE = ORIGINAL_POOL_SIZE;
	});

	it("an explicit linuxUser always wins, regardless of environment", () => {
		const agents = [{ id: "tutor", linuxUser: "magi-w3" }];
		expect(resolveLinuxUsers(agents, true).get("tutor")).toBe("magi-w3");
		expect(resolveLinuxUsers(agents, false).get("tutor")).toBe("magi-w3");
	});

	it("production (hasCreateUser=true): derives directly from agent.id", () => {
		const agents = [{ id: "tutor" }, { id: "mission-copilot" }];
		const resolved = resolveLinuxUsers(agents, true);
		expect(resolved.get("tutor")).toBe("tutor");
		expect(resolved.get("mission-copilot")).toBe("mission-copilot");
	});

	it("local dev (hasCreateUser=false): assigns pool slots in sorted order, stable regardless of input order", () => {
		const agentsA = [{ id: "tutor" }, { id: "mission-copilot" }];
		const agentsB = [{ id: "mission-copilot" }, { id: "tutor" }];
		const resolvedA = resolveLinuxUsers(agentsA, false);
		const resolvedB = resolveLinuxUsers(agentsB, false);
		// Sorted: "mission-copilot" < "tutor" alphabetically.
		expect(resolvedA.get("mission-copilot")).toBe("magi-w1");
		expect(resolvedA.get("tutor")).toBe("magi-w2");
		expect(resolvedB).toEqual(resolvedA);
	});

	it("local dev: fails loudly instead of reusing a slot when the team exceeds the pool size", () => {
		process.env.MAGI_POOL_SIZE = "2";
		const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];
		expect(() => resolveLinuxUsers(agents, false)).toThrow(
			/Local dev pool exhausted/,
		);
	});

	it("local dev: respects MAGI_POOL_SIZE for the fit check", () => {
		process.env.MAGI_POOL_SIZE = "3";
		const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const resolved = resolveLinuxUsers(agents, false);
		expect(resolved.size).toBe(3);
		expect(resolved.get("c")).toBe("magi-w3");
	});

	it("mixes explicit linuxUser and derived agents without consuming a pool slot for the explicit one", () => {
		process.env.MAGI_POOL_SIZE = "1";
		const agents = [{ id: "pinned", linuxUser: "magi-w5" }, { id: "derived" }];
		const resolved = resolveLinuxUsers(agents, false);
		expect(resolved.get("pinned")).toBe("magi-w5");
		expect(resolved.get("derived")).toBe("magi-w1");
	});
});
