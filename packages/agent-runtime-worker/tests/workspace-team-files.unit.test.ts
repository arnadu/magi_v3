/**
 * copyTeamFilesToSharedDir — runs at every boot and writes into shared/,
 * which agents can write, so a link an agent planted there must not redirect
 * the daemon's write (BND-2, sprint-28f audit). No ACL users are passed, so
 * no setfacl runs.
 */

import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyTeamFilesToSharedDir } from "../src/workspace-manager.js";

let base: string;
let team: string;
let shared: string;
let outside: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "team-files-")));
	team = join(base, "team");
	shared = join(base, "shared");
	outside = join(base, "outside");
	for (const d of [team, shared, outside]) mkdirSync(d);
	mkdirSync(join(team, "docs"));
	writeFileSync(join(team, "playbook.md"), "PLAYBOOK");
	writeFileSync(join(team, "docs", "ref.md"), "REF");
	writeFileSync(join(outside, "victim.conf"), "ORIGINAL");
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(base, { recursive: true, force: true });
});

describe("copyTeamFilesToSharedDir", () => {
	it("copies team files and directories into shared/", () => {
		copyTeamFilesToSharedDir(shared, team, []);
		expect(readFileSync(join(shared, "playbook.md"), "utf8")).toBe("PLAYBOOK");
		expect(readFileSync(join(shared, "docs", "ref.md"), "utf8")).toBe("REF");
	});

	it("does not write through a file symlink planted at a team file's name", () => {
		symlinkSync(join(outside, "victim.conf"), join(shared, "playbook.md"));
		copyTeamFilesToSharedDir(shared, team, []);
		expect(readFileSync(join(outside, "victim.conf"), "utf8")).toBe("ORIGINAL");
		expect(lstatSync(join(shared, "playbook.md")).isSymbolicLink()).toBe(true);
	});

	it("does not write into a directory symlink planted at a team directory's name", () => {
		symlinkSync(outside, join(shared, "docs"));
		copyTeamFilesToSharedDir(shared, team, []);
		expect(() => lstatSync(join(outside, "ref.md"))).toThrow(/ENOENT/);
		expect(readFileSync(join(shared, "playbook.md"), "utf8")).toBe("PLAYBOOK");
	});
});
