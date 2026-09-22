/**
 * ADR-0032 step 6.2 — the four new control-plane-copilot team skills, plus
 * the three extended ones, are discoverable exactly like every other team
 * skill (copilot-daemon.ts's provisionCopilotSkills() copies
 * config/teams/copilot/skills/ verbatim into the copilot's own "team" tier).
 * Only structural checks here (frontmatter valid, name/description present) —
 * per CLAUDE.md's testing approach, skill wording is judged manually, not
 * asserted on. No LLM calls, no network.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills } from "../src/skills.js";

const REPO_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);
const COPILOT_SKILLS_DIR = join(
	REPO_ROOT,
	"config",
	"teams",
	"copilot",
	"skills",
);

const NEW_SKILLS = [
	"daily-resource-report",
	"disk-pressure",
	"atlas-storage",
	"vm-upgrade-oversight",
];
const EXTENDED_SKILLS = ["cost-management", "mission-recovery"];

let testRoot: string;

beforeEach(() => {
	testRoot = mkdtempSync(join(tmpdir(), "magi-copilot-skills-"));
});

afterEach(() => {
	rmSync(testRoot, { recursive: true });
});

/** Copies one real skill's SKILL.md into a fresh team-tier fixture and discovers it. */
function discoverRealSkill(name: string) {
	const sharedDir = join(testRoot, "shared");
	const teamDir = join(sharedDir, "skills", "_team", name);
	mkdirSync(teamDir, { recursive: true });
	writeFileSync(
		join(teamDir, "SKILL.md"),
		readFileSync(join(COPILOT_SKILLS_DIR, name, "SKILL.md"), "utf-8"),
	);
	return discoverSkills(sharedDir, join(testRoot, "workdir"));
}

describe.each(NEW_SKILLS)("new copilot skill: %s", (name) => {
	it("has valid frontmatter and is discovered at the team tier", () => {
		const block = discoverRealSkill(name);
		const skill = block.skills.find((s) => s.name === name);
		expect(skill).toBeDefined();
		expect(skill?.scope).toBe("team");
		expect(skill?.description.length).toBeGreaterThan(0);
	});
});

describe.each(EXTENDED_SKILLS)("extended copilot skill: %s", (name) => {
	it("still has valid frontmatter after its ADR-0032 extension", () => {
		const block = discoverRealSkill(name);
		const skill = block.skills.find((s) => s.name === name);
		expect(skill).toBeDefined();
		expect(skill?.description.length).toBeGreaterThan(0);
	});
});

describe("incident-triage platform skill", () => {
	it("still has valid frontmatter after its ADR-0032 extension", () => {
		const sharedDir = join(testRoot, "shared");
		const platformDir = join(
			sharedDir,
			"skills",
			"_platform",
			"incident-triage",
		);
		mkdirSync(platformDir, { recursive: true });
		writeFileSync(
			join(platformDir, "SKILL.md"),
			readFileSync(
				join(REPO_ROOT, "packages", "skills", "incident-triage", "SKILL.md"),
				"utf-8",
			),
		);
		const block = discoverSkills(sharedDir, join(testRoot, "workdir"));
		const skill = block.skills.find((s) => s.name === "incident-triage");
		expect(skill).toBeDefined();
		expect(skill?.scope).toBe("platform");
	});
});
