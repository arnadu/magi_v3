import { defineEntity } from "./define-entity.js";

/** One agent's turn: from dispatch to its end, every step stored as it happens. */
export const TURN = defineEntity({
	id: "turn",
	name: "Turn (one agent's run from dispatch to its end)",
	store: {
		kind: "collection",
		collection: "agentTurnStats",
		type: "AgentTurnStats",
		statusField: "status",
	},
	states: [
		{
			id: "running",
			meaning: "Dispatched; its steps are being stored as they happen",
		},
		{ id: "completed", meaning: "Ended normally", stored: "complete" },
		{
			id: "failed",
			meaning:
				"Ended on a model error, a limit or the wall-clock timeout, with the reason recorded",
		},
		{
			id: "interrupted",
			meaning: "Cut short by a crash or a restart of the daemon",
			stored: "aborted",
		},
	],
	transitions: [
		{ from: null, event: "dispatched", to: "running", actors: ["PLT"] },
		{
			from: "running",
			event: "ends normally",
			to: "completed",
			actors: ["PLT"],
		},
		{
			from: "running",
			event: "a model error, a limit or the timeout",
			to: "failed",
			actors: ["PLT"],
		},
		{
			from: "running",
			event: "the daemon crashes or restarts",
			to: "interrupted",
			actors: ["PLT"],
			note: "What happens next is an open decision (`turn.no-silent-loss`)",
		},
	],
	invariants: [
		{
			id: "turn.reconstructible",
			text: "Any turn can be reconstructed from what is stored: the prompt and mental map it started from, every model call, every tool call with its arguments and result, its cost, and how it ended.",
			enforcedBy: [],
		},
		{
			id: "turn.persisted-per-step",
			text: "Each step of a turn (a model answer, a tool result) is stored before the next step starts, so a crash loses at most the step in progress. A sub-agent's steps are stored the same way, whether it runs in a turn or in a background job.",
			enforcedBy: [
				{
					kind: "runtime",
					where:
						"agent-runtime-worker/src/loop.ts: runInnerLoop (onMessage before the next step); agent-runtime-worker/src/tools/sub-agent-hooks.ts: SubAgentHooks (required by Investigate and Research)",
				},
				{ kind: "test" },
			],
		},
		{
			id: "turn.sub-agent-bounded",
			text: "A sub-agent (Investigate, Research) ends within its time, turn and (Investigate) money budget: its last step has no tools and tells it to answer from what it has, and its answer says what it did not finish and why. It is never extended, and never cut off without that last step except by its caller's abort or the backstop above its budget.",
			enforcedBy: [
				{
					kind: "runtime",
					where:
						"agent-runtime-worker/src/loop.ts: windDownReason, runInnerLoop (finalStep)",
				},
				{ kind: "test" },
			],
			decidedBy: "ADR-0039",
		},
		{
			id: "turn.no-silent-loss",
			text: "An interrupted turn is either resumed from its last stored step or closed with a recorded reason; it is never silently dropped or replayed from the start.",
			enforcedBy: [],
			open: "Resume from the last stored step (needs tools that are safe to repeat), or close the turn and start a new one",
		},
	],
	notes:
		"Its messages are in `conversationMessages`, one per step; its model calls are `llm-call`s.",
});

/** One item of a work queue (ADR-0040): an alert, a guard, later an article. */
export const WORK_ITEM = defineEntity({
	id: "work-item",
	name: "Work item (one entry of a review's backlog)",
	store: {
		kind: "other",
		where:
			"Files in the owning agent's workdir, written by its job through the review pipeline: `review/state/verdicts.json` (the verdict or marker), `ledger.jsonl` (every outcome), `seen.json`, `spend.json`; `priorities.json` is the agent's",
	},
	states: [
		{
			id: "due",
			meaning:
				"Listed and without a current verdict: new, a file it depends on changed, or its verdict reached its maximum age",
			stored: null,
		},
		{
			id: "deferred",
			meaning:
				"Due, not reached: a run's calls or minutes, or the day's budget, ran out first",
			stored: null,
		},
		{
			id: "held",
			meaning: "Due, put aside by the agent until a date, with a reason",
			stored: null,
		},
		{
			id: "incomplete",
			meaning:
				"An investigation ran out of time, turns or money: no verdict, asked again next run",
			stored: null,
		},
		{
			id: "failed",
			meaning: "An investigation errored: no verdict, asked again next run",
			stored: null,
		},
		{
			id: "over-budget",
			meaning:
				"Its own budget ran out before a verdict: a marker, not asked again until something it depends on changes or the agent pins it",
		},
		{
			id: "judged",
			meaning:
				"A verdict is stored: negative, unconfirmed, refuted, rejected, or a finding for the agent to verify",
			stored: null,
		},
	],
	transitions: [
		{
			from: null,
			event: "the producer lists it",
			to: "due",
			actors: ["JOB"],
		},
		{
			from: "due",
			event: "a run's or the day's budget runs out first",
			to: "deferred",
			actors: ["JOB"],
		},
		{
			from: "deferred",
			event: "the next run",
			to: "due",
			actors: ["JOB"],
		},
		{
			from: "due",
			event: "the agent holds it until a date, with a reason",
			to: "held",
			actors: ["AG"],
		},
		{ from: "held", event: "the date passes", to: "due", actors: ["JOB"] },
		{
			from: "due",
			event: "investigated: a verdict",
			to: "judged",
			actors: ["JOB", "SUB"],
		},
		{
			from: "due",
			event: "an investigation runs out of time, turns or money",
			to: "incomplete",
			actors: ["JOB", "SUB"],
		},
		{
			from: "due",
			event: "an investigation errors",
			to: "failed",
			actors: ["JOB"],
		},
		{
			from: "due",
			event: "its own budget cannot cover the next investigation",
			to: "over-budget",
			actors: ["JOB"],
		},
		{
			from: "incomplete",
			event: "the next run",
			to: "due",
			actors: ["JOB"],
		},
		{ from: "failed", event: "the next run", to: "due", actors: ["JOB"] },
		{
			from: "over-budget",
			event: "something it depends on changes, or the agent pins it",
			to: "due",
			actors: ["JOB", "AG"],
		},
		{
			from: "judged",
			event:
				"something it depends on changes, or its verdict reaches its maximum age",
			to: "due",
			actors: ["JOB"],
		},
	],
	invariants: [
		{
			id: "work-item.within-budget",
			text: "No investigation starts once the day's budget is spent, and an item's investigations together stay within the item's budget; every investigation's cost is counted, a failed one's too.",
			enforcedBy: [{ kind: "test" }],
			decidedBy: "ADR-0040",
			open: "Who may set the budgets: today the job's arguments, which the owning agent writes; the skill says they are the operator's, but nothing enforces it. A place only the operator or the mission copilot can set (the mission config) is the follow-up",
		},
		{
			id: "work-item.ordered",
			text: "Due items are worked pinned first, then new and changed before re-checks, then by the producer's priority, then the longest waiting; the agent changes the order only with a recorded reason.",
			enforcedBy: [{ kind: "test" }],
			decidedBy: "ADR-0040",
		},
		{
			id: "work-item.not-a-verdict",
			text: "An incomplete, failed or over-budget outcome is recorded with its reason and never stored as a verdict.",
			enforcedBy: [{ kind: "test" }],
			decidedBy: "ADR-0040",
		},
		{
			id: "work-item.verdict-stands",
			text: "A verdict changes only when something it depends on changes or it reaches its maximum age; never by hand.",
			enforcedBy: [{ kind: "test" }],
		},
	],
	notes:
		"The agent verifies a finding and files it in its own register; that step is the agent's work, not the item's state. Items no longer listed leave the backlog.",
});

/** One call to a model made on a mission's behalf. */
export const LLM_CALL = defineEntity({
	id: "llm-call",
	name: "Model call",
	store: {
		kind: "collection",
		collection: "llmCallLog",
		type: "LlmCallLogEntry",
	},
	states: [
		{
			id: "recorded",
			meaning:
				"Its row (who, model, tokens, cost, time) and its full input and output are stored",
		},
		{
			id: "summarized",
			meaning:
				"Past the retention period: the full input and output are removed, the row is kept",
		},
	],
	transitions: [
		{ from: null, event: "a model is called", to: "recorded", actors: ["PLT"] },
		{
			from: "recorded",
			event: "the retention period ends",
			to: "summarized",
			actors: ["PLT"],
		},
	],
	invariants: [
		{
			id: "llm-call.recorded",
			text: "Every model call made on a mission's behalf (by an agent, a copilot, a sub-agent, a tool or a job) is recorded with who made it, the model, tokens, cost and time, and its full input and output are kept for the retention period the operator sets.",
			enforcedBy: [
				{
					kind: "runtime",
					where:
						"agent-runtime-worker/src/llm-meter.ts: createLogOnlyMeter (loopModel required); agent-runtime-worker/src/tools/sub-agent-hooks.ts: SubAgentHooks",
				},
				{ kind: "test" },
			],
			decidedBy: "ADR-0017",
			open: "The retention period and where the bodies are kept (MongoDB, the mission's volume, object storage); whether tool results are kept in full",
		},
		{
			id: "llm-call.cost-counted",
			text: "Every recorded call's cost counts against its mission's spend. A sub-agent's calls count as its calling agent's: in a turn, that turn's; in a background job, the job's agent's.",
			enforcedBy: [
				{
					kind: "runtime",
					where:
						"agent-runtime-worker/src/daemon-boot/monitor-tool-servers.ts: createJobSpend; agent-runtime-worker/src/tool-api-server.ts: jobSubAgentHooks",
				},
				{ kind: "test" },
			],
			decidedBy: "ADR-0017",
		},
	],
});
