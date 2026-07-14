/**
 * Mission copilot injection + objectives seeding — unit tests (ADR-0016).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TeamConfig } from "@magi/agent-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildMissionCopilotAgentConfig,
	injectMissionCopilot,
	MISSION_COPILOT_AGENT_ID,
	seedMissionCopilotObjectives,
} from "../src/mission-copilot.js";
import { loadGoals, loadTaskEvents } from "../src/objectives/store.js";

function baseTeamConfig(): TeamConfig {
	return {
		mission: { id: "m1", name: "Test Mission" },
		agents: [
			{
				id: "lead",
				name: "Lead",
				supervisor: "user",
				systemPrompt: "You are the lead. Do the work.",
				initialMentalMap: '<section id="tasks"></section>',
			},
		],
	};
}

describe("buildMissionCopilotAgentConfig", () => {
	it("substitutes missionId/missionName/roster eagerly, leaves session placeholders intact", () => {
		const cfg = buildMissionCopilotAgentConfig(baseTeamConfig());
		expect(cfg.id).toBe(MISSION_COPILOT_AGENT_ID);
		expect(cfg.systemPrompt).toContain("mission `m1`");
		expect(cfg.systemPrompt).toContain('"Test Mission"');
		expect(cfg.systemPrompt).toContain("- lead (Lead):");
		// Left for buildSystemPrompt's existing per-session substitution:
		expect(cfg.systemPrompt).toContain("{{mentalMap}}");
		expect(cfg.systemPrompt).toContain("{{sharedDir}}");
		// Left for initMentalMap's substitution:
		expect(cfg.initialMentalMap).toContain("{{sharedDir}}");
		expect(cfg.initialMentalMap).toContain("{{workdir}}");
	});

	it("disables Research and InspectImage", () => {
		const cfg = buildMissionCopilotAgentConfig(baseTeamConfig());
		expect(cfg.disabledTools).toEqual(["Research", "InspectImage"]);
	});

	it("disables analyst-domain and broken/superseded skills", () => {
		const cfg = buildMissionCopilotAgentConfig(baseTeamConfig());
		expect(cfg.disabledSkills).toEqual(
			expect.arrayContaining([
				"github-issues",
				"schedule-task",
				"data-factory",
				"data-factory-client",
				"market-analysis-framework",
			]),
		);
	});
});

describe("injectMissionCopilot", () => {
	it("appends the copilot without disturbing agents[0]", () => {
		const teamConfig = baseTeamConfig();
		injectMissionCopilot(teamConfig);
		expect(teamConfig.agents).toHaveLength(2);
		expect(teamConfig.agents[0].id).toBe("lead");
		expect(teamConfig.agents[1].id).toBe(MISSION_COPILOT_AGENT_ID);
	});

	it("throws if an agent with the reserved id already exists (defense in depth)", () => {
		const teamConfig = baseTeamConfig();
		teamConfig.agents.push({
			id: MISSION_COPILOT_AGENT_ID,
			supervisor: "user",
			systemPrompt: "x",
			initialMentalMap: "<section></section>",
		});
		expect(() => injectMissionCopilot(teamConfig)).toThrow(/reserved id/);
	});
});

describe("seedMissionCopilotObjectives", () => {
	let shared: string;

	beforeEach(() => {
		shared = mkdtempSync(join(tmpdir(), "mission-copilot-seed-"));
	});
	afterEach(() => {
		rmSync(shared, { recursive: true, force: true });
	});

	it("writes five objectives and three seed tasks", async () => {
		await seedMissionCopilotObjectives(shared);

		const goals = await loadGoals(shared);
		expect(goals.objectives.map((o) => o.id)).toEqual([
			"OBJ-MISSION-FIT",
			"OBJ-TEAM-OBJECTIVES",
			"OBJ-ALIGNMENT",
			"OBJ-RESOURCES",
			"OBJ-TECH-HEALTH",
		]);
		// Every objective and KPI must carry a valid owner (schema-required).
		for (const o of goals.objectives) {
			expect(o.owner).toBe(MISSION_COPILOT_AGENT_ID);
			for (const k of o.kpis) expect(k.owner).toBe(MISSION_COPILOT_AGENT_ID);
		}

		const tasks = await loadTaskEvents(shared);
		expect(tasks.map((t) => t.id)).toEqual([
			"TASK-COPILOT-1",
			"TASK-COPILOT-2",
			"TASK-COPILOT-3",
		]);
		for (const t of tasks) {
			expect(t.assignee).toBe(MISSION_COPILOT_AGENT_ID);
			expect(t.status).toBe("open");
		}
	});

	it("is idempotent across repeated calls (resume_mission reprovisioning)", async () => {
		await seedMissionCopilotObjectives(shared);
		await seedMissionCopilotObjectives(shared);
		await seedMissionCopilotObjectives(shared);

		const goals = await loadGoals(shared);
		expect(goals.objectives).toHaveLength(5);

		const tasks = await loadTaskEvents(shared);
		expect(tasks).toHaveLength(3);
	});

	it("does not clobber a pre-existing goals.json with unrelated objectives", async () => {
		// Simulate a mission that already has its own (non-copilot) objectives
		// before the copilot's first run — e.g. authored by another agent.
		const { saveGoals } = await import("../src/objectives/store.js");
		await saveGoals(shared, {
			objectives: [
				{
					id: "OBJ-EXISTING",
					parent: null,
					title: "Pre-existing objective",
					owner: "lead",
					status: "active",
					kpis: [],
				},
			],
		});

		await seedMissionCopilotObjectives(shared);

		const goals = await loadGoals(shared);
		expect(goals.objectives.map((o) => o.id)).toContain("OBJ-EXISTING");
		expect(goals.objectives.map((o) => o.id)).toContain("OBJ-MISSION-FIT");
		expect(goals.objectives).toHaveLength(6);
	});
});
