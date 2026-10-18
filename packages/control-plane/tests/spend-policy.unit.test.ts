import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ceilingChangeRefusal,
	DEFAULT_MISSION_MAX_COST_USD,
	DEFAULT_PLATFORM_MAX_COST_CEILING_USD,
	effectiveCeilingUsd,
	platformMaxCostCeilingUsd,
	withDefaultSpendCap,
} from "../src/spend-policy.js";

describe("spend policy (ADR-0034 / D-3)", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("defaults the cap only when the config has none", () => {
		expect(withDefaultSpendCap({ id: "m", name: "M" }).maxCostUsd).toBe(
			DEFAULT_MISSION_MAX_COST_USD,
		);
		expect(
			withDefaultSpendCap({ id: "m", name: "M", maxCostUsd: 3 }).maxCostUsd,
		).toBe(3);
	});

	it("reads the platform ceiling from the environment, falling back to the default", () => {
		expect(platformMaxCostCeilingUsd({})).toBe(
			DEFAULT_PLATFORM_MAX_COST_CEILING_USD,
		);
		expect(
			platformMaxCostCeilingUsd({ PLATFORM_MAX_COST_CEILING_USD: "250" }),
		).toBe(250);
		expect(
			platformMaxCostCeilingUsd({ PLATFORM_MAX_COST_CEILING_USD: "nope" }),
		).toBe(DEFAULT_PLATFORM_MAX_COST_CEILING_USD);
		expect(
			platformMaxCostCeilingUsd({ PLATFORM_MAX_COST_CEILING_USD: "-5" }),
		).toBe(DEFAULT_PLATFORM_MAX_COST_CEILING_USD);
	});

	it("binds a mission without its own ceiling by the platform's", () => {
		expect(effectiveCeilingUsd({}, {})).toBe(
			DEFAULT_PLATFORM_MAX_COST_CEILING_USD,
		);
		expect(effectiveCeilingUsd({ maxCostCeilingUsd: 40 }, {})).toBe(40);
	});

	it("lets only an admin set a ceiling above the platform's", () => {
		expect(ceilingChangeRefusal(50, false, {})).toBeNull();
		expect(ceilingChangeRefusal(500, false, {})).toMatch(
			/platform ceiling of \$100\.00/,
		);
		expect(ceilingChangeRefusal(500, true, {})).toBeNull();
	});
});

describe("ceiling back-fill and repair (2026-10-18 regression)", () => {
	it("never writes a ceiling below a mission's existing cap, and repairs the first back-fill's mistake", async () => {
		const { fakeDb } = await import("./support/fake-db.js");
		const { backfillMissionCeilings } = await import("../src/spend-policy.js");
		const { db, data } = fakeDb({
			missions: [
				{ missionId: "none-low", mission: { maxCostUsd: 25 } },
				{ missionId: "none-high", mission: { maxCostUsd: 350 } },
				{ missionId: "none-uncapped", mission: {} },
				{
					missionId: "bad",
					maxCostCeilingUsd: 100,
					mission: { maxCostUsd: 200 },
				},
				{
					missionId: "operator-set",
					maxCostCeilingUsd: 60,
					mission: { maxCostUsd: 50 },
				},
			],
		});
		const n = await backfillMissionCeilings(db as never, {});
		const ceiling = (id: string) =>
			data.missions.find((m) => m.missionId === id)?.maxCostCeilingUsd;
		expect(ceiling("none-low")).toBe(100);
		expect(ceiling("none-high")).toBe(350);
		expect(ceiling("none-uncapped")).toBe(100);
		expect(ceiling("bad")).toBe(200);
		expect(ceiling("operator-set")).toBe(60);
		expect(n).toBe(4);
		expect(await backfillMissionCeilings(db as never, {})).toBe(0);
	});

	it("lets a PLATFORM_ADMIN_USER_IDS user exceed the platform ceiling, nobody else", async () => {
		const { mayExceedPlatformCeiling } = await import("../src/spend-policy.js");
		const env = { PLATFORM_ADMIN_USER_IDS: " uid-a , uid-b" };
		expect(mayExceedPlatformCeiling({ userId: "uid-b" }, env)).toBe(true);
		expect(mayExceedPlatformCeiling({ userId: "uid-c" }, env)).toBe(false);
		expect(mayExceedPlatformCeiling({ isAdmin: true }, {})).toBe(true);
		expect(mayExceedPlatformCeiling({}, env)).toBe(false);
	});
});
