/**
 * Mission copilot — daemon-injected team lead (ADR-0016, Track 2).
 *
 * Every mission gets one, injected in memory at daemon startup (never
 * authored in YAML — see the reserved-id check in @magi/agent-config's
 * parseTeamConfig). It runs through the exact same runAgent/runInnerLoop path
 * as any other agent; its elevated tool surface (Families A-G) is attached
 * separately via OrchestratorConfig.getAdditionalTools, keyed on the literal
 * agent id below, never on anything YAML- or config-controlled.
 */

import type { AgentConfig, TeamConfig } from "@magi/agent-config";
import type { ObjectivesRepository } from "./objectives/repository.js";
import type { ObjectiveDef, TaskEvent } from "./objectives/types.js";
import { loadPrompt } from "./prompts.js";

// Deliberately not "copilot": the cockpit frontend (packages/cockpit/src/data.ts)
// already hardcodes COPILOT_ID = "copilot" as a synthetic pseudo-agent for the
// cross-mission control-plane copilot, present on every mission's Conversations
// panel. A real per-mission agent sharing that literal id would collide with it —
// the cockpit has no way to distinguish the two, and every message to "copilot"
// would keep routing to the control-plane copilot, leaving this agent
// unreachable through the UI. Found live on a resumed mission (Gold Digest v2)
// shortly after this agent's default-on rollout.
export const MISSION_COPILOT_AGENT_ID = "mission-copilot";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * {{missionId}}/{{missionName}}/{{roster}} are substituted here, eagerly, at
 * injection time — teamConfig.mission and teamConfig.agents are already known
 * and stable at this point. {{mentalMap}}/{{sharedDir}}/{{workdir}} are left
 * as literal placeholder text — buildSystemPrompt substitutes them every
 * session, exactly as it does for every other agent's systemPrompt.
 */
function buildSystemPromptTemplate(
	missionId: string,
	missionName: string,
	roster: string,
): string {
	return loadPrompt("mission-copilot.md", { missionId, missionName, roster });
}

/**
 * Also called for a "draft" mission's not-yet-validated config (GET /:id/config
 * serves both the live ConfigPanel and the pre-launch DraftEditor) — a draft is
 * deliberately allowed to have an agent mid-edit with no systemPrompt yet
 * (PUT /:id/draft skips parseTeamConfig), so this must tolerate that rather
 * than assume every AgentConfig field is populated.
 */
function buildRosterText(teamConfig: TeamConfig): string {
	return teamConfig.agents
		.map((a) => {
			const summary = a.systemPrompt
				? a.systemPrompt.split("\n")[0].slice(0, 120)
				: "(no system prompt yet)";
			return `- ${a.id}${a.name ? ` (${a.name})` : ""}: ${summary}`;
		})
		.join("\n");
}

// ---------------------------------------------------------------------------
// Initial mental map
// ---------------------------------------------------------------------------

/**
 * {{sharedDir}}/{{workdir}} are left as literal placeholders — initMentalMap()
 * (mental-map.ts) substitutes them once, at agent-creation time, the same fix
 * this plan made for every agent (see ADR-0016 context).
 */
const initialMentalMap = (): string =>
	loadPrompt("mission-copilot-mental-map.html");

// ---------------------------------------------------------------------------
// Agent config
// ---------------------------------------------------------------------------

export function buildMissionCopilotAgentConfig(
	teamConfig: TeamConfig,
): AgentConfig {
	const { mission } = teamConfig;
	const roster = buildRosterText(teamConfig);
	return {
		id: MISSION_COPILOT_AGENT_ID,
		// Not "Copilot": the cockpit's cross-mission control-plane copilot
		// already renders under that exact label on every mission's
		// Conversations panel (packages/cockpit/src/data.ts's COPILOT_ID). A
		// second, identically-labeled chip would be functionally reachable
		// (the id collision is fixed) but visually indistinguishable — the
		// same practical confusion this rename was meant to close.
		name: "Mission Copilot",
		role: "lead",
		supervisor: "user",
		systemPrompt: buildSystemPromptTemplate(mission.id, mission.name, roster),
		initialMentalMap: initialMentalMap(),
		// No nested research sub-loop or image workload for a lead role.
		disabledTools: ["Research", "InspectImage"],
		// github-issues: its own SKILL.md already defers to the built-in
		// GitHub tools for copilot agents — and its scripts need GH_TOKEN,
		// which the execution plane never has (that's the whole point of the
		// GitHub proxy), so leaving it enabled would just let the copilot
		// wander into a script that always fails.
		// schedule-task: the file-based path (sharedDir/schedules/ →
		// scheduled_messages, schedule-ingest.ts) is for worker agents, whose
		// files are attributed to them by uid. The copilot has its own
		// CreateScheduledMessage/CancelScheduledMessage tools that write the
		// collection directly; a file it wrote would be attributed to it
		// anyway, so the skill is just a slower duplicate here.
		// data-factory / data-factory-client / market-analysis-framework:
		// analyst-domain skills, not this role — visible only as prompt
		// bloat, and could tempt the copilot into doing the team's
		// substantive work itself, which its own system prompt says not to.
		disabledSkills: [
			"github-issues",
			"schedule-task",
			"data-factory",
			"data-factory-client",
			"market-analysis-framework",
		],
		// A top-level TeamConfig field, not agents[].limits — the copilot has no
		// node in the authored agents list to hang a `limits` key off of. Same
		// LimitsSchema shape; set/edited via the cockpit Limits panel just like
		// any other agent's, or directly by the copilot's own SaveMissionConfig
		// tool (both write teamConfigYaml, this is just a different field in it).
		limits: teamConfig.missionCopilotLimits,
	};
}

// ---------------------------------------------------------------------------
// Injection (in-memory only — no filesystem access)
// ---------------------------------------------------------------------------

/**
 * Append the mission copilot to teamConfig.agents in memory. Must run before
 * WorkspaceManager.provision() so the copilot gets a real per-agent OS user
 * and workspace ACL through the exact same ensureAgentUsers()/provision()
 * path every other agent already goes through.
 *
 * Appends (never unshifts) — teamConfig.agents[0] stays whatever the authored
 * config's first agent is, which orchestrator.ts treats as the "lead agent"
 * for provisioning and dispatch order is plain array order, so appending
 * puts the copilot last in a given dispatch pass, not first.
 *
 * Throws if an authored agent already has this id — defense in depth on top
 * of parseTeamConfig's reserved-id rejection (Phase 1), which should already
 * have caught this at config-load time.
 */
export function injectMissionCopilot(teamConfig: TeamConfig): void {
	if (teamConfig.agents.some((a) => a.id === MISSION_COPILOT_AGENT_ID)) {
		throw new Error(
			`Team config already has an agent with the reserved id "${MISSION_COPILOT_AGENT_ID}" — this should have been rejected at parse time`,
		);
	}
	teamConfig.agents.push(buildMissionCopilotAgentConfig(teamConfig));
}

// ---------------------------------------------------------------------------
// Objectives seed (idempotent — must run after WorkspaceManager.provision())
// ---------------------------------------------------------------------------

const SEED_OBJECTIVES: ObjectiveDef[] = [
	{
		id: "OBJ-MISSION-FIT",
		parent: null,
		title:
			"This mission's parameters and team composition serve the user's actual intent",
		owner: MISSION_COPILOT_AGENT_ID,
		status: "active",
		kpis: [
			{
				id: "KPI-FIT",
				label: "team/mission fit",
				owner: MISSION_COPILOT_AGENT_ID,
				kind: "qualitative",
				source: "copilot-assessment",
				rubric: "met | partial | unmet",
			},
		],
	},
	{
		id: "OBJ-TEAM-OBJECTIVES",
		parent: null,
		title: "Every agent on this team has a current, actionable objective",
		owner: MISSION_COPILOT_AGENT_ID,
		status: "active",
		kpis: [
			{
				id: "KPI-COVERAGE",
				label: "agents without a current objective",
				owner: MISSION_COPILOT_AGENT_ID,
				kind: "quantitative",
				source: "copilot-assessment",
				target: 0,
				unit: "count",
			},
		],
	},
	{
		id: "OBJ-ALIGNMENT",
		parent: null,
		title:
			"Agent actions track the user's stated objectives, not just completed tasks",
		owner: MISSION_COPILOT_AGENT_ID,
		status: "active",
		kpis: [
			{
				id: "KPI-DRIFT",
				label: "unresolved drift incidents",
				owner: MISSION_COPILOT_AGENT_ID,
				kind: "quantitative",
				source: "copilot-assessment",
				target: 0,
				unit: "count",
			},
		],
	},
	{
		id: "OBJ-RESOURCES",
		parent: null,
		title:
			"Mission resources (cost, tokens, time) are used effectively toward its goals",
		owner: MISSION_COPILOT_AGENT_ID,
		status: "active",
		// budgetUsd intentionally omitted — not every mission needs a tracked
		// sub-budget; the copilot can set it later with EditObjectiveTree, at
		// which point the existing per-turn cost-attribution mechanism
		// (Sprint 26a) rolls real spend into it automatically.
		kpis: [
			{
				id: "KPI-COST-FIT",
				label: "spend proportionate to output",
				owner: MISSION_COPILOT_AGENT_ID,
				kind: "qualitative",
				source: "copilot-assessment",
				rubric: "met | partial | unmet",
			},
		],
	},
	{
		id: "OBJ-TECH-HEALTH",
		parent: null,
		title: "The mission's technical execution is healthy",
		owner: MISSION_COPILOT_AGENT_ID,
		status: "active",
		kpis: [
			{
				id: "KPI-OPEN-ISSUES",
				label: "unresolved technical issues",
				owner: MISSION_COPILOT_AGENT_ID,
				kind: "quantitative",
				source: "copilot-assessment",
				target: 0,
				unit: "count",
			},
			{
				id: "KPI-DIAGNOSTIC-QUALITY",
				label: "diagnoses backed by evidence, not guesses",
				owner: MISSION_COPILOT_AGENT_ID,
				kind: "qualitative",
				source: "copilot-assessment",
				rubric: "met | partial | unmet",
			},
		],
	},
];

function buildSeedTasks(now: string): TaskEvent[] {
	return [
		{
			id: "TASK-COPILOT-1",
			at: now,
			by: MISSION_COPILOT_AGENT_ID,
			title:
				"Review the mission's stated goals, current team composition, and each agent's system prompt and mental map — assess fit against OBJ-MISSION-FIT",
			objective: "OBJ-MISSION-FIT",
			assignee: MISSION_COPILOT_AGENT_ID,
			status: "open",
		},
		{
			id: "TASK-COPILOT-2",
			at: now,
			by: MISSION_COPILOT_AGENT_ID,
			title:
				"Confirm every agent has a current, actionable objective; define or flag gaps",
			objective: "OBJ-TEAM-OBJECTIVES",
			assignee: MISSION_COPILOT_AGENT_ID,
			status: "open",
		},
		{
			id: "TASK-COPILOT-3",
			at: now,
			by: MISSION_COPILOT_AGENT_ID,
			title:
				"Establish a recurring alignment-review cadence via a self-addressed scheduled message (see the system prompt's 'How you check alignment')",
			objective: "OBJ-ALIGNMENT",
			assignee: MISSION_COPILOT_AGENT_ID,
			status: "open",
		},
	];
}

/**
 * Seed the mission copilot's five objectives and three kick-off tasks into
 * the Mongo-backed objectives store (ADR-0019).
 *
 * Idempotent: resume_mission fully reprovisions the machine (delete +
 * recreate), so every suspend→resume cycle re-runs the daemon's startup path
 * including this call. Checking for OBJ-MISSION-FIT first prevents
 * duplicating the seed on every resume.
 */
export async function seedMissionCopilotObjectives(
	repo: ObjectivesRepository,
	missionId: string,
): Promise<void> {
	const goals = await repo.readGoals(missionId);
	if (goals.objectives.some((o) => o.id === "OBJ-MISSION-FIT")) return;

	await repo.saveGoals(
		missionId,
		{ objectives: [...goals.objectives, ...SEED_OBJECTIVES] },
		MISSION_COPILOT_AGENT_ID,
	);

	const now = new Date().toISOString();
	for (const task of buildSeedTasks(now)) {
		await repo.appendTaskEvent(missionId, task);
	}
}
