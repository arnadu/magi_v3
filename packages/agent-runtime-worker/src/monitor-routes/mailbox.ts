import type { Db } from "mongodb";
import type { MailboxRepository } from "../mailbox.js";
import { readBody } from "../monitor-server.js";
import type { RouteEntry } from "./types.js";

export interface MailboxRoutesDeps {
	db: Db;
	missionId: string;
	mailboxRepo: MailboxRepository;
}

/** GET /mailbox (last 500 messages) and POST /send-message (operator → agents). */
export function createMailboxRoutes(deps: MailboxRoutesDeps): RouteEntry[] {
	return [
		{
			method: "GET",
			path: "/mailbox",
			async handler({ res }) {
				const msgs = await deps.db
					.collection("mailbox")
					.find({ missionId: deps.missionId })
					.sort({ timestamp: 1 })
					.limit(500)
					.toArray();
				const payload = msgs.map((doc) => {
					const d = doc as {
						_id: unknown;
						from: string;
						to: string[];
						subject: string;
						body: string;
						timestamp?: Date;
					};
					return {
						id: String(d._id),
						from: d.from,
						to: d.to,
						subject: d.subject,
						bodyPreview:
							d.body.length > 400 ? `${d.body.slice(0, 400)}…` : d.body,
						body: d.body,
						timestamp: (d.timestamp ?? new Date()).toISOString(),
					};
				});
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(payload));
			},
		},
		{
			method: "POST",
			path: "/send-message",
			async handler({ req, res }) {
				const body = await readBody(req);
				let parsed: unknown;
				try {
					parsed = JSON.parse(body);
				} catch {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Invalid JSON" }));
					return;
				}
				const { to, subject, message } = parsed as Record<string, unknown>;
				if (
					!Array.isArray(to) ||
					to.length === 0 ||
					!to.every((r) => typeof r === "string") ||
					typeof subject !== "string" ||
					typeof message !== "string" ||
					message.trim() === ""
				) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							error:
								"to (non-empty string[]), subject (string), and message (string) are required",
						}),
					);
					return;
				}
				await deps.mailboxRepo.post({
					missionId: deps.missionId,
					from: "user",
					to: to as string[],
					subject: subject || "Operator message",
					body: message,
				});
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			},
		},
	];
}
