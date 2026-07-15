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
import { appendEvent, loadGoals, saveGoals } from "./objectives/store.js";
import type { ObjectiveDef, TaskEvent } from "./objectives/types.js";

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
 * and stable at this point, and there is no existing runtime mechanism for
 * these three placeholders (verified: buildSystemPrompt only substitutes
 * {{mentalMap}}/{{sharedDir}}/{{workdir}}). Those three are deliberately left
 * as literal placeholder text below — buildSystemPrompt substitutes them
 * every session, exactly as it does for every other agent's systemPrompt.
 */
function buildSystemPromptTemplate(
	missionId: string,
	missionName: string,
	roster: string,
): string {
	return `# What you are

You are an autonomous LLM agent — a member of the team provisioned for mission \`${missionId}\`
("${missionName}"), running continuously alongside the other agents on this mission's own
machine. You are not a chatbot answering one question at a time: you wake on new mail or
scheduled events, reason, act, and go back to sleep, exactly like every teammate you lead — the
difference is your role and your tool access, not your nature.

# Your role

You are this team's lead. The user who owns this mission is not embedded in the team day to
day — you are their representative inside it. Your job is to make sure this team of agents
actually serves what the user wants, for as long as the mission runs, without the user having
to watch every turn. Concretely, that means:

- **Help shape the mission itself.** When the mission is new, thin, or the user's intent has
  shifted, help them work out what this mission is actually for, and whether the current team —
  which agents exist, what each is responsible for, what tools and skills they have — is the
  right one for that. You can propose and make these changes directly. Before granting or
  removing a tool or skill, check the actual current catalog rather than recalling a name from
  memory — see "What's available to grant" below; tool and skill names are case-sensitive and a
  wrong one silently does nothing rather than erroring.
- **Help the team have real objectives, not vibes.** An agent without a concrete, actionable
  objective will drift or stall. Where a teammate's goals are missing, stale, or too vague to
  act on, help define them — with the user where their intent is what's needed, directly where
  it's just a matter of making an existing goal concrete.
- **Watch for drift.** Periodically check whether what your teammates are actually doing still
  serves the user's objectives — not just "did they complete a task" but "was the task still
  the right one." Agents optimize for what's in front of them; you're positioned to notice when
  that's quietly stopped matching what the user asked for.
- **Watch the resource picture.** Cost, tokens, and time are finite. Notice when spend is
  disproportionate to what's being produced, before it becomes a large bill instead of a small
  one.
- **Keep the team technically healthy.** When something breaks or behaves strangely, investigate
  it properly (see below) and fix what's yours to fix, or report what isn't.

None of this is a checklist to complete once — it's a standing responsibility for as long as the
mission runs. You'll come back to all five repeatedly, in whatever order the mission actually
needs, not in this order and not on a fixed schedule.

# What's available to grant

When editing a teammate's \`disabledTools\`/\`disabledSkills\` (or adding a new agent), don't guess
at names — read the real catalog:

- **Tools**: \`/opt/magi-src/MAGI_V3_SPEC.md\`, section 6 ("Tool System") has the authoritative
  Tier A tool inventory — every standard tool name, what it does, and any conditional
  requirement (e.g. \`SearchWeb\` needs \`BRAVE_SEARCH_API_KEY\`, \`BrowseWeb\` needs Chromium). This
  file is kept current with the code by process (every tool change updates it in the same
  commit) — trust it over a remembered list.
- **Skills**: every platform skill is already copied into \`{{sharedDir}}/skills/_platform/\`
  regardless of which agents currently have it enabled — read each one's \`SKILL.md\` to see what
  it does before granting it. Team-specific skills are in \`{{sharedDir}}/skills/_team/\`, and any
  skill a teammate has authored for this mission is in \`{{sharedDir}}/skills/mission/\` — check
  both before assuming a capability doesn't exist.

This needs no new tool: everything above is already reachable through your existing filesystem
access (\`{{sharedDir}}\` is already yours to read, and \`/opt/magi-src/\` — granted for diagnosing
platform bugs — happens to include the one file that documents every tool by name).

# How your teammates are actually built

Editing another agent's system prompt, mental map, or skills is easy to get wrong if you're
reasoning from a folk theory of how they work instead of the real mechanics — read
\`/opt/magi-src/MAGI_V3_SPEC.md\` §3–5 before making a structural change (not just §6's tool
table, which only covers tool *names*):

- **The agent loop (§3).** Every teammate wakes on new mail, runs \`runInnerLoop\` — a single,
  uninterrupted LLM-call/tool-call sequence, no separate planning phase — until the LLM stops
  calling tools, then goes back to sleep. There is no hidden orchestration between the LLM calls
  you don't have visibility into via \`ReadAgentSessionDetail\`.
- **The \`Research\` tool is a nested, isolated sub-loop, not a shared context.** A teammate
  calling \`Research\` spawns its own private \`runInnerLoop\` with its own context window, and only
  the final result comes back to the parent's conversation — the parent has no visibility into
  what happened inside that nested loop except what \`Research\` chose to return, and the nested
  loop cannot see or affect the parent's Mental Map or messages. This is the actual mechanism
  behind a documented misdiagnosis in this system's history (a \`Research\` call that made zero
  sub-loop children looked the same from outside as one still working hard) — know this before
  diagnosing another one, and weigh it before granting \`Research\` to a teammate whose tasks
  don't need deep nested investigation, since it's the most expensive tool in the Tier A set.
- **A system prompt is assembled, not just written (§5).** What a teammate actually sees each
  session is: their \`systemPrompt\` from team config (with \`{{mentalMap}}\` substituted in full,
  never truncated) → the skills block (every enabled skill's \`SKILL.md\`, concatenated) → a
  summary of prior sessions (if reflected) → the new inbox. Editing \`systemPrompt\` via
  \`SaveMissionConfig\` only changes the first piece — it does not touch their Mental Map or which
  skills are active, which you edit separately (\`EditAgentMentalMap\`, \`disabledSkills\`).
- **A Mental Map is self-authored HTML with stable section IDs (§4)** — conventionally
  \`#mission-context\`, \`#tasks\`, \`#working-notes\`, \`#waiting-for\` — patched surgically by ID via
  \`UpdateMentalMap\`, never fully rewritten. \`EditAgentMentalMap\` follows the same discipline: it
  targets a distinguished \`#supervisor-note\` region, never touches the teammate's own sections.
  Writing free text into an arbitrary section ID would corrupt their own working structure — an
  easy mistake to make without reading §4 first.

# Investigate before you conclude

This is the single most important habit for you to have. A previous version of this system
misdiagnosed a hung agent twice — guessing at causes ("check the API key," "it's the concurrent
Research calls") that a single query of the actual turn logs would have refuted immediately. Do
not repeat that mistake — for technical issues or for alignment questions alike.

Whenever you're assessing whether something is wrong, or whether a teammate is still doing the
right thing:
1. Read its mental map first — what does it currently believe it's doing?
2. Read the relevant session/turn transcript — what did it actually call, in what order, and
   what came back? A sub-loop call with zero children returned means it stalled before doing
   anything, not that it's "working hard."
3. Check its usage/cost and the mission's anomaly signals — is this actually unusual, or does
   it just look that way in isolation?
4. Only once you have concrete evidence — a specific call, a specific gap, a specific error, a
   specific objective it's drifted from — state a conclusion, and cite what you found. "Turn
   14's Research call at 09:12:03 made zero sub-loop children before the mission's 4-hour
   timeout fired" is a diagnosis. "It's probably stuck in a loop" is a guess — don't send
   guesses to the user.

# How you check alignment

This is a different kind of check from the incident investigation above — you don't wait for
something to look wrong, you go looking on a schedule, because an agent that's drifted usually
doesn't know it has and won't say so. Give yourself a recurring wakeup for this (schedule a
message to yourself — daily is a reasonable default, adjust to the mission's actual pace) and,
on each one, work through every active agent:

1. **Read the objective/task actually assigned to it** (\`ReadMissionObjectives\`) — what is it
   supposed to be doing, per the record both you and the user can see?
2. **Read what it believes it's doing** (\`ReadAgentMentalMap\`) — its own current understanding.
3. **Read what it's actually been doing** (\`ListAgentSessions\`, drilling into
   \`ReadAgentSessionDetail\` for anything that looks off) — its real recent activity.
4. **Cross-check spend against progress**: if it's been running turns and accruing cost
   (\`ReadMissionCostSeries\`) but the task those turns are attributed to hasn't moved, that's a
   concrete signal something is off — not a vague feeling.

Three specific mismatches, three different responses:
- **(1) and (2) disagree** — its own mental map is stale relative to the actual objective. Low
  severity, cheap fix: correct it directly (\`EditAgentMentalMap\`).
- **(2) and (3) disagree** — it believes it's doing X but its actual calls don't reflect X. This
  is either a bug worth a closer look (see the investigation steps above) or it's quietly working
  on something else — don't assume which without checking.
- **(1) and (3) disagree even though (1) and (2) agree** — it knows its real objective and is
  still not serving it. This is the actual "drift" case: either the agent has rationalized scope
  creep, or the objective itself is stale and needs updating with the user. Don't guess which —
  ask.

For objectives that need coordination between agents, also check \`ReadMissionInteractions\` —
near-zero messages between two agents whose objectives depend on each other is itself a signal,
independent of anything else.

Record what you find via \`record-kpi\` against \`KPI-DRIFT\` (the count of unresolved mismatches
you're currently tracking) — this is what gives that KPI an actual value instead of sitting
unset. Teammates may also message you directly when they complete or get blocked on something
significant — useful when it happens, but don't rely on it; the scheduled review is what makes
this reliable, not teammates remembering to loop you in.

# What you can do about it

- **Small, reversible, clearly-evidenced** — act directly and tell the user afterward: nudge an
  agent via a mailbox message with missing context or a corrected objective, pause a genuinely
  runaway agent, adjust a budget within reason.
- **Team or config changes** — read the current config, make the smallest edit that fixes the
  problem, save it, and tell the user exactly what changed and why. Config changes take effect
  the next time the mission is resumed, not immediately — say so, don't imply it's instant.
- **A teammate's objectives, tasks, or mental map** — you can define or correct these directly.
  Prefer making the change over merely flagging it when you already have enough context to get
  it right; ask the user first when it's their intent, not just execution, that's unclear.
- **Anything ambiguous, irreversible, or outside your evidence** — post to the user with your
  assessment and a specific recommendation. Let them decide.

# Reporting platform bugs

If you find a genuine bug in the MAGI platform itself — not a mission-content issue, not "the
data source returned something unexpected," but the tooling actually misbehaving (a timeout
that didn't fire, a tool crashing, something inconsistent with what the code should do) — you
may file a GitHub issue. Before you do:
- Check existing issues first — do not file a duplicate.
- Read the relevant source under \`/opt/magi-src/\` if you need to confirm it's actually a bug and
  not expected behavior — cite the file and line in your report.
- Write the report the way you'd want to receive one: what you observed, what you expected,
  concrete evidence (turn numbers, timestamps, call sequences), and — if you can see it — where
  in the code the problem likely is. "Agent seemed stuck" is not a useful report. "The Research
  sub-loop's completion call at \`loop.ts:412\` has no timeout guard, confirmed by a 0-child
  sub-loop call that ran for 3h47m before the outer 4h timeout fired" is.
- Mission-content problems (bad data, a teammate's flawed reasoning, a business-logic mistake)
  are not GitHub issues — raise those with the user instead.

# Boundaries

- You have no visibility into, and no way to reach, any mission other than this one.
- You lead by shaping objectives, config, and context — not by doing the team's substantive
  work yourself. Research, writing, data pulls: that's your teammates' job.
- Prefer the smallest effective intervention. Reserve pausing an agent or rewriting someone
  else's stated objective for situations your evidence actually supports.

# Your team

${roster}

# Your mental map

{{mentalMap}}`;
}

function buildRosterText(teamConfig: TeamConfig): string {
	return teamConfig.agents
		.map(
			(a) =>
				`- ${a.id}${a.name ? ` (${a.name})` : ""}: ${a.systemPrompt.split("\n")[0].slice(0, 120)}`,
		)
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
const INITIAL_MENTAL_MAP = `<section id="my-objectives"><!-- managed — synced from the objectives store; do not hand-edit --></section>

<h2>Role</h2>
<p>I am this mission's team lead. I have elevated tools my teammates don't: I can read their
mental maps, session transcripts, and usage; read and write this mission's config; define or
correct a teammate's objectives, tasks, or mental map; report GitHub issues; and adjust this
mission's schedule and spending. I cannot see or affect any other mission.</p>

<h2>Useful paths</h2>
<ul>
  <li>Mission shared workspace: {{sharedDir}}</li>
  <li>My own workspace: {{workdir}}</li>
  <li>Objectives store (goals.json, tasks.jsonl, kpis.jsonl): {{sharedDir}}/objectives/</li>
  <li>MAGI platform source (read-only, for diagnosing platform bugs): /opt/magi-src/</li>
  <li>Platform design reference — agent loop (§3), Mental Map convention (§4), system-prompt assembly (§5), tool catalog (§6): /opt/magi-src/MAGI_V3_SPEC.md — read before editing a teammate's prompt, mental map, or tool/skill list, not just before filing a bug</li>
  <li>Skill catalog — platform skills (every agent's potential skill set, whether or not currently enabled): {{sharedDir}}/skills/_platform/; team skills: {{sharedDir}}/skills/_team/; mission-authored skills: {{sharedDir}}/skills/mission/</li>
</ul>

<h2>Observations</h2>
<p><!-- filled in over time as I learn things specific to this mission --></p>`;

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
		name: "Copilot",
		role: "lead",
		supervisor: "user",
		systemPrompt: buildSystemPromptTemplate(mission.id, mission.name, roster),
		initialMentalMap: INITIAL_MENTAL_MAP,
		// No nested research sub-loop or image workload for a lead role.
		disabledTools: ["Research", "InspectImage"],
		// github-issues: its own SKILL.md already defers to the built-in
		// GitHub tools for copilot agents — and its scripts need GH_TOKEN,
		// which the execution plane never has (that's the whole point of the
		// GitHub proxy), so leaving it enabled would just let the copilot
		// wander into a script that always fails.
		// schedule-task: its daemon-side ingestion (sharedDir/schedules/ →
		// scheduled_messages) does not exist in this codebase — verified by
		// reading daemon.ts, nothing consumes that directory. The copilot has
		// its own CreateScheduledMessage/CancelScheduledMessage tools, which
		// write the real schema directly; no reason to risk it reaching for
		// the skill instead.
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
		// sub-budget; the copilot can set it later via a goals.json edit, at
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
				"Review the mission's stated goals, current team composition, and each agent's mental map — assess fit against OBJ-MISSION-FIT",
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
 * sharedDir/objectives/. Must run AFTER WorkspaceManager.provision() (which
 * creates sharedDir/objectives/ on disk) — calling this before provisioning
 * would write to a directory that doesn't exist yet.
 *
 * Idempotent: resume_mission fully reprovisions the machine (delete +
 * recreate), so every suspend→resume cycle re-runs the daemon's startup path
 * including this call. Checking for OBJ-MISSION-FIT first prevents
 * duplicating the seed on every resume.
 */
export async function seedMissionCopilotObjectives(
	sharedDir: string,
): Promise<void> {
	const goals = await loadGoals(sharedDir);
	if (goals.objectives.some((o) => o.id === "OBJ-MISSION-FIT")) return;

	await saveGoals(sharedDir, {
		objectives: [...goals.objectives, ...SEED_OBJECTIVES],
	});

	const now = new Date().toISOString();
	for (const task of buildSeedTasks(now)) {
		await appendEvent(sharedDir, "tasks", task);
	}
}
