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
				// Field names must match ScheduledMessageDoc (scheduler.ts) exactly:
				// pending/delivered/cancelled/failed status, deliverAt (Date, doubles
				// as "next fire time" for cron entries too — scheduler.ts re-arms a
				// delivered cron doc by writing its next occurrence back into this
				// same field), optional cron expression string. The previous version
				// read cronExpression/scheduledFor and filtered on deliveredAt — none
				// of which are real fields on this collection, so every row always
				// came back with a blank "when" column.
				const docs = await deps.db
					.collection("scheduled_messages")
					.find({ missionId: deps.missionId, status: "pending" })
					.sort({ deliverAt: 1 })
					.limit(50)
					.toArray();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify(
						docs.map((d) => ({
							id: String(d._id),
							to: d.to ?? [],
							subject: d.subject ?? "",
							cronExpression: d.cron ?? null,
							scheduledFor: d.deliverAt
								? new Date(d.deliverAt).toISOString()
								: null,
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
