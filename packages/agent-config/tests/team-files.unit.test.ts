import { describe, expect, it } from "vitest";
import {
	MAX_TEAM_FILE_BYTES,
	MAX_TEAM_FILES,
	validateTeamFilePath,
	validateTeamFiles,
} from "../src/team-files.js";

/**
 * TF1/CHAIN-A (2026-10-15 audit) — team-files-sync.ts does
 * `join(teamDir, relPath)` then writeFileSync with no validation. These are
 * the exact attack shapes from the finding: a traversal into the daemon's
 * own HOME writes a `.gitconfig` that GIT1's unhardened git calls execute.
 */
describe("validateTeamFilePath", () => {
	it("rejects a traversal into the daemon's HOME (the CHAIN-A payload)", () => {
		expect(() =>
			validateTeamFilePath("../../home/magi-operator/.gitconfig"),
		).toThrow(/escape/);
	});

	it("rejects an absolute path", () => {
		expect(() => validateTeamFilePath("/etc/passwd")).toThrow(/relative/);
	});

	it("rejects a path that normalizes to an escape", () => {
		expect(() => validateTeamFilePath("a/../../x")).toThrow(/escape/);
	});

	it("rejects a bare '..'", () => {
		expect(() => validateTeamFilePath("..")).toThrow(/escape/);
	});

	it("rejects a NUL byte", () => {
		expect(() => validateTeamFilePath("a\0b")).toThrow(/NUL/);
	});

	it("rejects an empty string", () => {
		expect(() => validateTeamFilePath("")).toThrow(/non-empty/);
	});

	it("accepts a normal nested relative path", () => {
		expect(() => validateTeamFilePath("skills/foo/SKILL.md")).not.toThrow();
	});

	it("accepts a path that normalizes down to something safe (no net escape)", () => {
		expect(() => validateTeamFilePath("a/b/../c")).not.toThrow();
	});
});

describe("validateTeamFiles", () => {
	it("rejects more than MAX_TEAM_FILES entries", () => {
		const files = Array.from({ length: MAX_TEAM_FILES + 1 }, (_, i) => ({
			path: `f${i}.txt`,
			content: "x",
		}));
		expect(() => validateTeamFiles(files)).toThrow(/too many files/);
	});

	it("rejects a file over the byte cap", () => {
		expect(() =>
			validateTeamFiles([
				{ path: "big.txt", content: "x".repeat(MAX_TEAM_FILE_BYTES + 1) },
			]),
		).toThrow(/exceeds/);
	});

	it("rejects a traversal path buried in an otherwise-valid array", () => {
		expect(() =>
			validateTeamFiles([
				{ path: "ok.txt", content: "fine" },
				{ path: "../../etc/passwd", content: "evil" },
			]),
		).toThrow(/escape/);
	});

	it("accepts a normal, small team-files array", () => {
		expect(() =>
			validateTeamFiles([
				{ path: "skills/foo/SKILL.md", content: "# Foo" },
				{ path: "data/seed.json", content: "{}" },
			]),
		).not.toThrow();
	});
});
