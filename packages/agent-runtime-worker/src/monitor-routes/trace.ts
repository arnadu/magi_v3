import type { Db } from "mongodb";
import type { RouteEntry } from "./types.js";

export interface TraceRoutesDeps {
	db: Db;
	missionId: string;
}

/**
 * Trace-panel analytics: lifetime stats, the cost-over-time chart's per-turn
 * series, agent-pair interaction counts, and message-timeline markers. All
 * pure read-only Mongo aggregations keyed on missionId, no other state.
 */
export function createTraceRoutes(deps: TraceRoutesDeps): RouteEntry[] {
	return [
		{
			method: "GET",
			path: "/mission-stats",
			async handler({ res }) {
				const docs = await deps.db
					.collection("missionStats")
					.find(
						{ missionId: deps.missionId },
						{
							projection: {
								agentId: 1,
								lifetimeCostUsd: 1,
								lifetimeLlmCallCount: 1,
								lifetimeTurnCount: 1,
								_id: 0,
							},
						},
					)
					.toArray();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(docs));
			},
		},
		{
			method: "GET",
			path: "/cost-series",
			// Per-agent per-turn stats, for the cost-over-time chart and its
			// turn/file/anomaly markers — only finalized turns have a settled
			// cost and duration.
			async handler({ res }) {
				const docs = await deps.db
					.collection("agentTurnStats")
					.find(
						{ missionId: deps.missionId, completedAt: { $exists: true } },
						{
							projection: {
								agentId: 1,
								turnNumber: 1,
								startedAt: 1,
								completedAt: 1,
								costUsd: 1,
								llmCallCount: 1,
								peakContextTokens: 1,
								status: 1,
								gitChangedFiles: 1,
								_id: 0,
							},
						},
					)
					.sort({ completedAt: 1 })
					.toArray();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(docs));
			},
		},
		{
			method: "GET",
			path: "/interactions",
			// Message counts between agent pairs.
			async handler({ res }) {
				const docs = await deps.db
					.collection("mailbox")
					.aggregate([
						{ $match: { missionId: deps.missionId } },
						{ $unwind: "$to" },
						{
							$group: {
								_id: { from: "$from", to: "$to" },
								count: { $sum: 1 },
							},
						},
					])
					.toArray();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify(
						docs.map((d) => ({
							from: (d._id as { from: string; to: string }).from,
							to: (d._id as { from: string; to: string }).to,
							count: d.count as number,
						})),
					),
				);
			},
		},
		{
			method: "GET",
			path: "/message-events",
			// Per-message timestamps, for the message/scheduled-wakeup markers on
			// the timeline. Scheduler-delivered messages are written with
			// `createdAt` instead of `timestamp` — see scheduler.ts — so both are
			// folded here rather than fixed at the write site, to avoid touching
			// the read-status semantics of the existing mailbox/scheduler code
			// for an unrelated visualization.
			async handler({ res }) {
				const docs = await deps.db
					.collection("mailbox")
					.aggregate([
						{ $match: { missionId: deps.missionId } },
						{
							$project: {
								_id: 0,
								from: 1,
								to: 1,
								subject: 1,
								timestamp: { $ifNull: ["$timestamp", "$createdAt"] },
							},
						},
						{ $sort: { timestamp: 1 } },
					])
					.toArray();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(docs));
			},
		},
	];
}
