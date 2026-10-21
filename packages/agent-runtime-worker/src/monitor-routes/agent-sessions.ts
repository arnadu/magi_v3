import { storedCollection } from "@magi/agent-config";
import type { Db } from "mongodb";
import type { RouteEntry } from "./types.js";

export interface AgentSessionsDeps {
	db: Db;
	missionId: string;
}

/** One summary per turn: timing, call and tool counts, token and cost totals. */
async function sessionSummaries(deps: AgentSessionsDeps, agentId: string) {
	// AS-R1: only the per-turn totals' inputs, not the ~135 KB call bodies.
	const llmDocs = await storedCollection(deps.db, "llmCallLog")
		.find(
			{ agentId, missionId: deps.missionId },
			{
				projection: {
					turnNumber: 1,
					savedAt: 1,
					isReflection: 1,
					usage: 1,
				},
			},
		)
		.sort({ turnNumber: 1, savedAt: 1 })
		.toArray();

	const byTurn = new Map<number, typeof llmDocs>();
	for (const d of llmDocs) {
		const turnDocs = byTurn.get(d.turnNumber) ?? [];
		turnDocs.push(d);
		byTurn.set(d.turnNumber, turnDocs);
	}

	const toolCounts = await storedCollection(deps.db, "conversationMessages")
		.aggregate<{ _id: number; count: number }>([
			{
				$match: {
					agentId,
					missionId: deps.missionId,
					"message.role": "toolResult",
					parentToolUseId: { $exists: false },
				},
			},
			{ $group: { _id: "$turnNumber", count: { $sum: 1 } } },
		])
		.toArray();
	const toolCountMap = new Map(toolCounts.map((t) => [t._id, t.count]));

	const sessions = Array.from(byTurn.entries()).map(([turn, docs]) => {
		// Every group holds at least one call: it was created from one.
		const first = docs[0];
		const last = docs[docs.length - 1];
		const durationMs = last.savedAt.getTime() - first.savedAt.getTime();
		const totals = docs.reduce(
			(acc, d) => ({
				inputTokens: acc.inputTokens + d.usage.inputTokens,
				outputTokens: acc.outputTokens + d.usage.outputTokens,
				cacheReadTokens: acc.cacheReadTokens + d.usage.cacheReadTokens,
				costUsd: acc.costUsd + d.usage.cost.totalCostUsd,
			}),
			{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
		);
		return {
			turnNumber: turn,
			isReflection: first.isReflection,
			startTime: first.savedAt,
			endTime: last.savedAt,
			durationMs,
			llmCalls: docs.length,
			toolCalls: toolCountMap.get(turn) ?? 0,
			...totals,
		};
	});

	return sessions;
}

/**
 * Per-agent transcript/session inspection: mental map, aggregated per-turn
 * session summaries, one turn's full detail, and raw LLM-call usage history.
 * All read-only Mongo queries keyed on missionId+agentId.
 */
export function createAgentSessionsRoutes(
	deps: AgentSessionsDeps,
): RouteEntry[] {
	return [
		{
			method: "GET",
			path: /^\/agents\/([^/]+)\/mental-map$/,
			async handler({ res }, agentId) {
				const doc = await storedCollection(
					deps.db,
					"conversationMessages",
				).findOne(
					{
						agentId,
						missionId: deps.missionId,
						mentalMapHtml: { $exists: true },
					},
					{ sort: { turnNumber: -1, seqInTurn: -1 } },
				);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						agentId,
						html: doc?.mentalMapHtml ?? "",
					}),
				);
			},
		},
		{
			method: "GET",
			path: /^\/agents\/([^/]+)\/sessions$/,
			async handler({ res }, agentId) {
				const sessions = await sessionSummaries(deps, agentId);
				sessions.sort((a, b) => a.turnNumber - b.turnNumber);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(sessions));
			},
		},
		{
			method: "GET",
			path: /^\/agents\/([^/]+)\/sessions\/(\d+)$/,
			async handler({ res }, agentId, turnParam) {
				const turnNumber = Number.parseInt(turnParam, 10);

				const msgs = await storedCollection(deps.db, "conversationMessages")
					.find({ agentId, missionId: deps.missionId, turnNumber })
					.sort({ seqInTurn: 1 })
					.toArray();

				const llmCalls = await storedCollection(deps.db, "llmCallLog")
					.find({ agentId, missionId: deps.missionId, turnNumber })
					.sort({ savedAt: 1 })
					.toArray();

				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ turnNumber, messages: msgs, llmCalls }));
			},
		},
		{
			method: "GET",
			path: /^\/agents\/([^/]+)\/usage$/,
			async handler({ res }, agentId) {
				const docs = await storedCollection(deps.db, "llmCallLog")
					.find(
						{ missionId: deps.missionId, agentId },
						{
							projection: {
								turnNumber: 1,
								isReflection: 1,
								savedAt: 1,
								model: 1,
								"input.toolNames": 1,
								usage: 1,
							},
						},
					)
					.sort({ turnNumber: 1, savedAt: 1 })
					.toArray();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify(
						docs.map((d) => ({
							turnNumber: d.turnNumber,
							isReflection: d.isReflection,
							savedAt: d.savedAt,
							model: d.model,
							// undefined (not []) when the call body is gone, so callers can
							// tell "no tools offered" from "no longer known".
							toolNames: d.input?.toolNames,
							usage: d.usage,
						})),
					),
				);
			},
		},
	];
}
