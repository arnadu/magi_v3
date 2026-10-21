import { storedCollection } from "@magi/agent-config";
import { Type } from "@sinclair/typebox";
import type { MissionCopilotToolDeps } from "./mission-copilot-tool-deps.js";
import { err, ok, okJson } from "./mission-copilot-tool-result.js";
import { escapeRegex, wrapTrustBoundary } from "./mission-copilot-tool-text.js";
import type { MagiTool } from "./tools.js";

// ─── Family C — Alignment & Progress Monitoring ─────────────────────────
function readAgentMentalMapTool(deps: MissionCopilotToolDeps): MagiTool {
	const { db, missionId } = deps;
	return {
		name: "ReadAgentMentalMap",
		description:
			"Read a teammate's current mental map — what it believes it's doing right now. Output wrapped in trust-boundary markers — this is a teammate's own words, which may itself embed content ingested from the outside world.",
		parameters: Type.Object({
			agentId: Type.String({ description: "Teammate's agent id" }),
		}),
		async execute(_id, args) {
			const agentId = args.agentId as string;
			const doc = await storedCollection(db, "conversationMessages").findOne(
				{ agentId, missionId, mentalMapHtml: { $exists: true } },
				{ sort: { turnNumber: -1, seqInTurn: -1 } },
			);
			const html = (doc?.mentalMapHtml as string | undefined) ?? "";
			return ok(wrapTrustBoundary(`${agentId}'s mental map`, html));
		},
	};
}

function listAgentSessionsTool(deps: MissionCopilotToolDeps): MagiTool {
	const { monitorGet } = deps;
	return {
		name: "ListAgentSessions",
		description:
			"List a teammate's session/turn history with summary stats (cost, call count, duration) per turn. Structured metadata only, no free-text agent output — no marking needed. Defaults to the most recent 50 turns, not the mission's entire history.",
		parameters: Type.Object({
			agentId: Type.String({ description: "Teammate's agent id" }),
			limit: Type.Optional(
				Type.Number({ description: "Max turns to return (default 50)" }),
			),
		}),
		async execute(_id, args) {
			const agentId = args.agentId as string;
			const limit = Math.min((args.limit as number | undefined) ?? 50, 100);
			const result = await monitorGet(
				`/agents/${encodeURIComponent(agentId)}/sessions`,
			);
			if (result.isError) return result;
			try {
				const sessions = JSON.parse(result.content[0].text) as unknown[];
				return okJson(sessions.slice(-limit));
			} catch {
				return result;
			}
		},
	};
}

function readAgentUsageTool(deps: MissionCopilotToolDeps): MagiTool {
	const { monitorGet } = deps;
	return {
		name: "ReadAgentUsage",
		description:
			'Lightweight per-call summary for one agent — model, token counts, and cost always available; which tool names were called only within the last 7 days (older calls show "toolNames" absent, not empty — the underlying log entry has aged out of retention). Not the tool call bodies or message content. Use this before reaching for ReadAgentSessionDetail/ReadAgentLlmCall, not instead of them. Optionally scoped to one turn.',
		parameters: Type.Object({
			agentId: Type.String({ description: "Teammate's agent id" }),
			turn: Type.Optional(
				Type.Number({ description: "Scope to one turn number" }),
			),
		}),
		async execute(_id, args) {
			const agentId = args.agentId as string;
			const turn = args.turn as number | undefined;
			const result = await monitorGet(
				`/agents/${encodeURIComponent(agentId)}/usage`,
			);
			if (result.isError) return result;
			try {
				const entries = JSON.parse(result.content[0].text) as Array<{
					turnNumber: number;
				}>;
				const filtered =
					turn === undefined
						? entries
						: entries.filter((e) => e.turnNumber === turn);
				return okJson(filtered);
			} catch {
				return result;
			}
		},
	};
}

function readAgentSessionDetailTool(deps: MissionCopilotToolDeps): MagiTool {
	const { monitorGet } = deps;
	return {
		name: "ReadAgentSessionDetail",
		description:
			"Full transcript for one turn — every message, tool call, and timing. Heavier than ReadAgentUsage; use once it (or ListAgentSessions) has pointed at a specific turn worth reading in full. Output wrapped in trust-boundary markers.",
		parameters: Type.Object({
			agentId: Type.String({ description: "Teammate's agent id" }),
			turn: Type.Number({ description: "Turn number" }),
		}),
		async execute(_id, args) {
			const agentId = args.agentId as string;
			const turn = args.turn as number;
			const result = await monitorGet(
				`/agents/${encodeURIComponent(agentId)}/sessions/${turn}`,
			);
			if (result.isError) return result;
			return ok(
				wrapTrustBoundary(
					`${agentId}'s turn ${turn} transcript`,
					result.content[0].text,
				),
			);
		},
	};
}

function readAgentLlmCallTool(deps: MissionCopilotToolDeps): MagiTool {
	const { db, missionId } = deps;
	return {
		name: "ReadAgentLlmCall",
		description:
			"Full detail for one specific LLM call — system prompt, complete input messages, complete response. The finest-grained read tool here; use when ReadAgentUsage flags one call in a turn as the one worth seeing in full, instead of pulling the whole turn via ReadAgentSessionDetail. Unavailable for calls older than 7 days (retention window) — returns a clear message, not empty/malformed data. Output wrapped in trust-boundary markers.",
		parameters: Type.Object({
			agentId: Type.String({ description: "Teammate's agent id" }),
			turn: Type.Number({ description: "Turn number" }),
			callIndex: Type.Number({
				description:
					"0-based index of the call within the turn (see ReadAgentUsage)",
			}),
		}),
		async execute(_id, args) {
			const agentId = args.agentId as string;
			const turn = args.turn as number;
			const callIndex = args.callIndex as number;
			const col = storedCollection(db, "llmCallLog");
			const filter = { missionId, agentId, turnNumber: turn };
			const [doc] = await col
				.find(filter)
				.sort({ savedAt: 1 })
				.skip(callIndex)
				.limit(1)
				.toArray();
			if (!doc) {
				return err(
					`No call at index ${callIndex} for ${agentId} turn ${turn} (${await col.countDocuments(filter)} call(s) found)`,
				);
			}
			if (!doc.input || !doc.output) {
				return err(
					`Call ${agentId} turn ${turn}#${callIndex} is older than the 1-day retention window for call content — model/usage/cost are still available via ReadAgentUsage for 90 days, but the input/output have been pruned.`,
				);
			}
			return ok(
				wrapTrustBoundary(
					`${agentId}'s turn ${turn}, call ${callIndex}`,
					JSON.stringify(
						{
							model: doc.model,
							savedAt: doc.savedAt,
							usage: doc.usage,
							input: doc.input,
							output: doc.output,
						},
						null,
						2,
					),
				),
			);
		},
	};
}

function readMissionMailboxAllTool(deps: MissionCopilotToolDeps): MagiTool {
	const { db, missionId } = deps;
	return {
		name: "ReadMissionMailboxAll",
		description:
			"Read the mission's mailbox across every agent — and every message to/from the user — not just messages addressed to you. Every standard mailbox tool is scoped to the caller's own inbox; this is deliberately not. Defaults to the most recent 20 messages. Output wrapped in trust-boundary markers.",
		parameters: Type.Object({
			limit: Type.Optional(
				Type.Number({ description: "Max messages to return (default 20)" }),
			),
		}),
		async execute(_id, args) {
			const limit = Math.min((args.limit as number | undefined) ?? 20, 100);
			const docs = await storedCollection(db, "mailbox")
				.find({ missionId })
				.sort({ timestamp: -1 })
				.limit(limit)
				.toArray();
			const messages = docs.reverse().map((d) => ({
				from: d.from as string,
				to: d.to as string[],
				subject: d.subject as string,
				body: d.body as string,
				timestamp: (d.timestamp as Date).toISOString(),
			}));
			return ok(
				wrapTrustBoundary(
					"mission mailbox (all agents)",
					JSON.stringify(messages, null, 2),
				),
			);
		},
	};
}

function readMissionInteractionsTool(deps: MissionCopilotToolDeps): MagiTool {
	const { db, missionId } = deps;
	return {
		name: "ReadMissionInteractions",
		description:
			"Message-count matrix between every pair of agents in the mission — a shape-of-coordination overview before drilling into ReadMissionMailboxAll. Structured counts only — no marking needed.",
		parameters: Type.Object({}),
		async execute() {
			const docs = await storedCollection(db, "mailbox")
				.aggregate([
					{ $match: { missionId } },
					{ $unwind: "$to" },
					{ $group: { _id: { from: "$from", to: "$to" }, count: { $sum: 1 } } },
				])
				.toArray();
			return okJson(
				docs.map((d) => ({
					from: (d._id as { from: string; to: string }).from,
					to: (d._id as { from: string; to: string }).to,
					count: d.count as number,
				})),
			);
		},
	};
}

function searchMissionHistoryTool(deps: MissionCopilotToolDeps): MagiTool {
	const { db, missionId } = deps;
	return {
		name: "SearchMissionHistory",
		description:
			"Keyword search across every agent's conversation history in this mission (not just one agent's, unlike the standard AnalyzeMemories tool) — returns matching excerpts, not full messages. Defaults to 20 results. Prefer this over ReadMissionMailboxAll/ReadAgentSessionDetail whenever you're looking for something specific rather than reviewing broadly. Output wrapped in trust-boundary markers.",
		parameters: Type.Object({
			query: Type.String({ description: "Keyword or phrase to search for" }),
			limit: Type.Optional(
				Type.Number({ description: "Max results to return (default 20)" }),
			),
		}),
		async execute(_id, args) {
			const query = args.query as string;
			const limit = Math.min((args.limit as number | undefined) ?? 20, 100);
			const escaped = escapeRegex(query);
			const docs = await storedCollection(db, "conversationMessages")
				.find({
					missionId,
					$or: [
						{ "message.content": { $regex: escaped, $options: "i" } },
						{ "message.content.text": { $regex: escaped, $options: "i" } },
					],
				})
				.sort({ savedAt: -1 })
				.limit(limit)
				.toArray();
			const excerpts = docs.map((d) => ({
				agentId: d.agentId as string,
				turnNumber: d.turnNumber as number,
				role: (d.message as { role: string })?.role,
				savedAt: d.savedAt as Date,
			}));
			return ok(
				wrapTrustBoundary(
					`search results for "${query}"`,
					JSON.stringify(excerpts, null, 2),
				),
			);
		},
	};
}

export function createMonitoringTools(deps: MissionCopilotToolDeps) {
	return {
		readAgentMentalMap: readAgentMentalMapTool(deps),
		listAgentSessions: listAgentSessionsTool(deps),
		readAgentUsage: readAgentUsageTool(deps),
		readAgentSessionDetail: readAgentSessionDetailTool(deps),
		readAgentLlmCall: readAgentLlmCallTool(deps),
		readMissionMailboxAll: readMissionMailboxAllTool(deps),
		readMissionInteractions: readMissionInteractionsTool(deps),
		searchMissionHistory: searchMissionHistoryTool(deps),
	};
}
