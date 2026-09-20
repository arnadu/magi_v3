/**
 * Guard for ADR-0031 Decision 1: runtime segments are only complete if every
 * machine provision / stop / restart / destroy goes through
 * machine-lifecycle.ts. Fails if any other control-plane module imports the
 * raw functions from fly-machines.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const RAW_LIFECYCLE = [
	"provisionMission",
	"suspendMission",
	"resumeMission",
	"destroyMission",
];
// fly-machines.ts defines them; machine-lifecycle.ts is the one sanctioned caller.
const ALLOWED = new Set(["fly-machines.ts", "machine-lifecycle.ts"]);

describe("machine lifecycle guard", () => {
	const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));

	it("finds the control-plane sources it is meant to scan", () => {
		expect(files).toContain("missions.ts");
		expect(files).toContain("scheduler.ts");
		expect(files).toContain("copilot-router.ts");
	});

	it.each(
		files.filter((f) => !ALLOWED.has(f)),
	)("%s does not import the raw Fly lifecycle functions", (file) => {
		const source = readFileSync(join(SRC, file), "utf8");
		const imports = [
			...source.matchAll(
				/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"\.\/fly-machines\.js"/g,
			),
		].flatMap((m) =>
			m[1]
				.split(",")
				.map((n) => n.trim().replace(/^type\s+/, ""))
				.filter(Boolean),
		);
		expect(imports.filter((n) => RAW_LIFECYCLE.includes(n))).toEqual([]);
	});
});
