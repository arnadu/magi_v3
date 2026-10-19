import { storedCollection } from "@magi/agent-config";
import type { Db } from "mongodb";
import type { RouteEntry } from "./types.js";

export interface ScheduleRoutesDeps {
	db: Db;
	missionId: string;
	cancelSchedule?: (id: string) => Promise<void>;
}

/** GET /schedule (pending scheduled messages) and DELETE /schedule/:id. */
export function createScheduleRoutes(deps: ScheduleRoutesDeps): RouteEntry[] {
	return [
		{
			method: "GET",
			path: "/schedule",
			async handler({ res }) {
				const docs = await storedCollection(deps.db, "scheduledMessages")
					.find({ missionId: deps.missionId, status: "pending" })
					.sort({ deliverAt: 1 })
					.limit(50)
					.toArray();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify(
						docs.map((d) => ({
							id: String(d._id),
							to: d.to,
							subject: d.subject,
							cronExpression: d.cron ?? null,
							scheduledFor: d.deliverAt.toISOString(),
						})),
					),
				);
			},
		},
		{
			method: "DELETE",
			path: /^\/schedule\/([^/]+)$/,
			async handler({ res }, id) {
				if (!deps.cancelSchedule) {
					res.writeHead(501, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "cancelSchedule not configured" }));
					return;
				}
				try {
					await deps.cancelSchedule(id);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
				} catch (e) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: (e as Error).message }));
				}
			},
		},
	];
}
