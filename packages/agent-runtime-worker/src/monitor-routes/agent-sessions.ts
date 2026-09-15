import type { Db } from "mongodb";
import type { RouteEntry } from "./types.js";

export interface AgentSessionsDeps {
	db: Db;
	missionId: string;
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
				const doc = await deps.db.collection("conversationMessages").findOne(
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
						// biome-ignore lint/suspicious/noExplicitAny: raw MongoDB document
						html: (doc as any)?.mentalMapHtml ?? "",
					}),
				);
			},
		},
		{
			method: "GET",
			path: /^\/agents\/([^/]+)\/sessions$/,
			async handler({ res }, agentId) {
				const llmDocs = await deps.db
					.collection("llmCallLog")
					.find({ agentId, missionId: deps.missionId })
					.sort({ turnNumber: 1, savedAt: 1 })
					.toArray();

				const byTurn = new Map<number, typeof llmDocs>();
				for (const d of llmDocs) {
					// biome-ignore lint/suspicious/noExplicitAny: raw MongoDB document
					const t = (d as any).turnNumber ?? 0;
					if (!byTurn.has(t)) byTurn.set(t, []);
					byTurn.get(t)?.push(d);
				}

				const toolCounts = await deps.db
					.collection("conversationMessages")
					.aggregate([
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
				const toolCountMap = new Map(
					// biome-ignore lint/suspicious/noExplicitAny: raw MongoDB aggregate result
					toolCounts.map((t: any) => [t._id, t.count]),
				);

				const sessions = Array.from(byTurn.entries()).map(([turn, docs]) => {
					// biome-ignore lint/suspicious/noExplicitAny: raw MongoDB documents
					const isReflection = (docs[0] as any)?.isReflection ?? false;
					// biome-ignore lint/suspicious/noExplicitAny: raw MongoDB documents
					const startTime = (docs[0] as any)?.savedAt;
					// biome-ignore lint/suspicious/noExplicitAny: raw MongoDB documents
					const endTime = (docs[docs.length - 1] as any)?.savedAt;
					const durationMs =
						startTime && endTime
							? new Date(endTime).getTime() - new Date(startTime).getTime()
							: 0;
					const totals = docs.reduce(
						// biome-ignore lint/suspicious/noExplicitAny: raw MongoDB documents
						(acc: any, d: any) => ({
							inputTokens: acc.inputTokens + (d.usage?.inputTokens ?? 0),
							outputTokens: acc.outputTokens + (d.usage?.outputTokens ?? 0),
							cacheReadTokens:
								acc.cacheReadTokens + (d.usage?.cacheReadTokens ?? 0),
							costUsd: acc.costUsd + (d.usage?.cost?.total ?? 0),
						}),
						{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
					);
					return {
						turnNumber: turn,
						isReflection,
						startTime,
						endTime,
						durationMs,
						llmCalls: docs.length,
						toolCalls: toolCountMap.get(turn) ?? 0,
						...totals,
					};
				});

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

				const msgs = await deps.db
					.collection("conversationMessages")
					.find({ agentId, missionId: deps.missionId, turnNumber })
					.sort({ seqInTurn: 1 })
					.toArray();

				const llmCalls = await deps.db
					.collection("llmCallLog")
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
				const docs = await deps.db
					.collection("llmCallLog")
					.find({ missionId: deps.missionId, agentId })
					.sort({ turnNumber: 1, savedAt: 1 })
					.toArray();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify(
						docs.map((d) => ({
							turnNumber: d.turnNumber ?? 0,
							isReflection: d.isReflection ?? false,
							savedAt: d.savedAt,
							model: d.model ?? null,
							// input is absent after the 7-day retention window — same
							// window that governs d.output; toolNames degrades to
							// undefined for older calls rather than an empty array, so
							// callers can distinguish "no tools available" from "no
							// longer known".
							toolNames: d.input?.toolNames,
							usage: d.usage ?? null,
						})),
					),
				);
			},
		},
	];
}
