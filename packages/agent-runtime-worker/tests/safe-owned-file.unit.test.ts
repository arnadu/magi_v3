import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ownerOfRequestFile } from "../src/safe-owned-file.js";

const me = process.getuid?.() ?? 0;

describe("ownerOfRequestFile", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "owned-file-"));
	});
	const asAgent = { daemonUid: -1, uidToAgentId: new Map([[me, "analyst"]]) };

	it("names the agent that owns a plain file", () => {
		writeFileSync(join(dir, "a.json"), "{}");
		expect(ownerOfRequestFile(join(dir, "a.json"), 1000, asAgent)).toEqual({
			kind: "owned",
			owner: "analyst",
		});
	});

	it.each([
		[
			"symlink",
			() => {
				writeFileSync(join(dir, "t.json"), "{}");
				symlinkSync(join(dir, "t.json"), join(dir, "x.json"));
			},
		],
		["not a regular file", () => mkdirSync(join(dir, "x.json"))],
		[
			"hard link",
			() => {
				writeFileSync(join(dir, "t.json"), "{}");
				linkSync(join(dir, "t.json"), join(dir, "x.json"));
			},
		],
		[
			"file too large",
			() => writeFileSync(join(dir, "x.json"), "x".repeat(2000)),
		],
	])("refuses a %s", (reason, make) => {
		make();
		expect(ownerOfRequestFile(join(dir, "x.json"), 1000, asAgent)).toEqual({
			kind: "refused",
			reason,
		});
	});

	it("refuses a file the daemon owns, and one no agent owns", () => {
		writeFileSync(join(dir, "a.json"), "{}");
		const path = join(dir, "a.json");
		expect(
			ownerOfRequestFile(path, 1000, { ...asAgent, daemonUid: me }),
		).toMatchObject({ kind: "refused", reason: /owned by the daemon/ });
		expect(
			ownerOfRequestFile(path, 1000, {
				daemonUid: -1,
				uidToAgentId: new Map(),
			}),
		).toMatchObject({
			kind: "refused",
			reason: /not an agent of this mission/,
		});
	});

	it("reports a file removed before the check as gone", () => {
		expect(ownerOfRequestFile(join(dir, "none.json"), 1000, asAgent)).toEqual({
			kind: "gone",
		});
	});
});
