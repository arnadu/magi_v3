/**
 * Sprint 5 — Unit tests for skill discovery and formatting.
 *
 * Tests discoverSkills() scope resolution (higher-tier skill shadows lower-tier
 * skill of the same name) and formatSkillsBlock() output format.
 *
 * No LLM calls, no network access, no side effects on the real filesystem.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills, formatSkillsBlock } from "../src/skills.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testRoot: string;

beforeEach(() => {
	testRoot = mkdtempSync(join(tmpdir(), "magi-skills-unit-"));
});

afterEach(() => {
	rmSync(testRoot, { recursive: true });
});

function writeSkill(tierPath: string, name: string, description: string): void {
	const dir = join(tierPath, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: |\n  ${description}\n---\n`,
	);
}

function sharedDir(): string {
	return join(testRoot, "shared");
}
function workdir(): string {
	return join(testRoot, "workdir");
}
function platformPath(): string {
	return join(sharedDir(), "skills", "_platform");
}
function teamPath(): string {
	return join(sharedDir(), "skills", "_team");
}
function missionPath(): string {
	return join(sharedDir(), "skills", "mission");
}
function agentPath(): string {
	return join(workdir(), "skills");
}

// ---------------------------------------------------------------------------
// discoverSkills
// ---------------------------------------------------------------------------

describe("discoverSkills", () => {
	it("returns empty skill list when no tiers exist", () => {
		mkdirSync(sharedDir(), { recursive: true });
		mkdirSync(workdir(), { recursive: true });

		const block = discoverSkills(sharedDir(), workdir());
		expect(block.skills).toHaveLength(0);
		expect(block.platformPath).toBe(join(sharedDir(), "skills", "_platform"));
		expect(block.missionPath).toBe(join(sharedDir(), "skills", "mission"));
		expect(block.agentPath).toBe(join(workdir(), "skills"));
	});

	it("discovers platform skills", () => {
		writeSkill(platformPath(), "git-provenance", "Record completed work.");

		const block = discoverSkills(sharedDir(), workdir());
		expect(block.skills).toHaveLength(1);
		expect(block.skills[0]).toMatchObject({
			name: "git-provenance",
			scope: "platform",
			description: "Record completed work.",
		});
	});

	it("mission skill shadows platform skill of the same name", () => {
		writeSkill(platformPath(), "my-skill", "Platform version.");
		writeSkill(missionPath(), "my-skill", "Mission override.");

		const block = discoverSkills(sharedDir(), workdir());
		const matches = block.skills.filter((s) => s.name === "my-skill");
		expect(matches).toHaveLength(1);
		expect(matches[0].scope).toBe("mission");
		expect(matches[0].description).toBe("Mission override.");
	});

	it("team skill shadows platform skill of the same name", () => {
		writeSkill(platformPath(), "my-skill", "Platform version.");
		writeSkill(teamPath(), "my-skill", "Team override.");

		const block = discoverSkills(sharedDir(), workdir());
		const matches = block.skills.filter((s) => s.name === "my-skill");
		expect(matches).toHaveLength(1);
		expect(matches[0].scope).toBe("team");
	});

	it("agent skill shadows mission skill of the same name", () => {
		writeSkill(missionPath(), "my-skill", "Mission version.");
		writeSkill(agentPath(), "my-skill", "Agent override.");

		const block = discoverSkills(sharedDir(), workdir());
		const matches = block.skills.filter((s) => s.name === "my-skill");
		expect(matches).toHaveLength(1);
		expect(matches[0].scope).toBe("agent");
		expect(matches[0].description).toBe("Agent override.");
	});

	it("collects skills from all tiers simultaneously", () => {
		writeSkill(platformPath(), "platform-only", "Platform skill.");
		writeSkill(teamPath(), "team-only", "Team skill.");
		writeSkill(missionPath(), "mission-only", "Mission skill.");
		writeSkill(agentPath(), "agent-only", "Agent skill.");

		const block = discoverSkills(sharedDir(), workdir());
		const names = block.skills.map((s) => s.name);
		expect(names).toContain("platform-only");
		expect(names).toContain("team-only");
		expect(names).toContain("mission-only");
		expect(names).toContain("agent-only");
	});

	it("skips directories without a SKILL.md", () => {
		mkdirSync(join(platformPath(), "no-skill"), { recursive: true });
		writeSkill(platformPath(), "valid-skill", "Has a SKILL.md.");

		const block = discoverSkills(sharedDir(), workdir());
		expect(block.skills).toHaveLength(1);
		expect(block.skills[0].name).toBe("valid-skill");
	});

	it("skips SKILL.md files with malformed frontmatter", () => {
		mkdirSync(join(platformPath(), "bad-skill"), { recursive: true });
		writeFileSync(
			join(platformPath(), "bad-skill", "SKILL.md"),
			"no frontmatter here",
		);
		writeSkill(platformPath(), "good-skill", "Valid skill.");

		const block = discoverSkills(sharedDir(), workdir());
		const names = block.skills.map((s) => s.name);
		expect(names).not.toContain("bad-skill");
		expect(names).toContain("good-skill");
	});
});

// ---------------------------------------------------------------------------
// formatSkillsBlock
// ---------------------------------------------------------------------------

describe("formatSkillsBlock", () => {
	it("includes the three explicit absolute paths", () => {
		mkdirSync(sharedDir(), { recursive: true });
		mkdirSync(workdir(), { recursive: true });
		const block = discoverSkills(sharedDir(), workdir());
		const text = formatSkillsBlock(block);

		expect(text).toContain(block.platformPath);
		expect(text).toContain(block.missionPath);
		expect(text).toContain(block.agentPath);
	});

	it("lists each skill with its scope tag and one-line description", () => {
		writeSkill(platformPath(), "git-provenance", "Record work in git.");
		writeSkill(missionPath(), "report-format", "Write formal reports.");

		const block = discoverSkills(sharedDir(), workdir());
		const text = formatSkillsBlock(block);

		expect(text).toContain("git-provenance [platform]");
		expect(text).toContain("Record work in git.");
		expect(text).toContain("report-format [mission]");
		expect(text).toContain("Write formal reports.");
	});

	it("produces a section header", () => {
		mkdirSync(sharedDir(), { recursive: true });
		const block = discoverSkills(sharedDir(), workdir());
		const text = formatSkillsBlock(block);
		expect(text).toContain("## Available Skills");
	});
});
