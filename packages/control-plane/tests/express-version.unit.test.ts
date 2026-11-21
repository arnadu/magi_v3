import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("the control plane's Express", () => {
	it("is the root node_modules copy, the only one its image ships", () => {
		// The image copies /app/node_modules and not the package's own; a copy
		// nested under packages/control-plane would make tests run another
		// Express than production (found 2026-11-21: tests on 4, the image on 5).
		const fromPackage = createRequire(
			join(ROOT, "packages/control-plane/src/index.ts"),
		).resolve("express/package.json");
		expect(fromPackage).toBe(join(ROOT, "node_modules/express/package.json"));
		const { version } = createRequire(import.meta.url)(
			"express/package.json",
		) as { version: string };
		expect(version).toMatch(/^5\./);
	});
});
