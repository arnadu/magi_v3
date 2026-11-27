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
			text: "A sub-agent (Investigate, Research) ends within its time and turn budget: its last step has no tools and tells it to answer from what it has, and its answer says what it did not finish and why. It is never extended, and never cut off without that last step except by its caller's abort or the backstop above its budget.",
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
