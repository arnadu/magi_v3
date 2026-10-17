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
