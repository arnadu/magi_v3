import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import { createCopilotTools } from "../src/copilot-tools.js";
import type { PendingActionsStore } from "../src/pending-actions.js";

describe("MAGI_V3_SPEC.md §6 control-plane copilot table", () => {
	it("lists exactly the tools createCopilotTools builds, in order", () => {
		const spec = readFileSync(
			join(__dirname, "..", "..", "..", "MAGI_V3_SPEC.md"),
			"utf8",
		);
		const from = spec.indexOf("### Tier B elevated tools (copilot only)");
		const table = spec.slice(
			from,
			spec.indexOf("**Mission-copilot Tier B tools", from),
		);
		const documented = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map(
			(m) => m[1],
		);
		// Construction only takes collection handles; no query runs.
		const db = {
			collection: () => ({ createIndex: async () => "" }),
		} as unknown as Db;
		const built = createCopilotTools(
			db,
			() => {},
			{} as PendingActionsStore,
			"u1",
		).map((t) => t.name);
		expect(documented).toEqual(built);
	});
});
