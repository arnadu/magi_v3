/**
 * ADR-0031 step 4.1 — the real `packages/skills/request-resources/SKILL.md`
 * is discoverable exactly like every other platform skill (WorkspaceManager
 * copies the whole `packages/skills/` tree verbatim into `_platform/`, so
 * this file needs no separate registration). No LLM calls, no network.
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
const SKILL_PATH = join(
	REPO_ROOT,
	"packages",
	"skills",
	"request-resources",
	"SKILL.md",
);

let testRoot: string;

beforeEach(() => {
	testRoot = mkdtempSync(join(tmpdir(), "magi-skills-request-resources-"));
});

afterEach(() => {
	rmSync(testRoot, { recursive: true });
});

describe("request-resources platform skill", () => {
	it("is discovered at the platform tier with the expected name and scope", () => {
		const sharedDir = join(testRoot, "shared");
		const platformDir = join(
			sharedDir,
			"skills",
			"_platform",
			"request-resources",
		);
		mkdirSync(platformDir, { recursive: true });
		writeFileSync(
			join(platformDir, "SKILL.md"),
			readFileSync(SKILL_PATH, "utf-8"),
		);

		const block = discoverSkills(sharedDir, join(testRoot, "workdir"));
		const found = block.skills.find((s) => s.name === "request-resources");

		expect(found).toBeDefined();
		expect(found?.scope).toBe("platform");
		expect(found?.description.length).toBeGreaterThan(0);
	});

	it("has both a worker-agent and a mission-copilot section, since the skill is their shared contract", () => {
		const content = readFileSync(SKILL_PATH, "utf-8");
		expect(content).toMatch(/## If you are a worker agent/);
		expect(content).toMatch(/## If you are the mission-copilot/);
	});

	it("names the real tools it tells agents to use", () => {
		const content = readFileSync(SKILL_PATH, "utf-8");
		for (const tool of [
			"PostMessage",
			"RequestResourceUpgrade",
			"EndResourceUpgrade",
			"ListTeam",
			"ReadMissionLog",
			"ListBackgroundJobs",
		]) {
			expect(content).toContain(tool);
		}
	});

	it("tells agents with no mission-copilot to ask the user instead", () => {
		const content = readFileSync(SKILL_PATH, "utf-8");
		expect(content).toMatch(/MISSION_COPILOT_ENABLED=false/);
	});
});
