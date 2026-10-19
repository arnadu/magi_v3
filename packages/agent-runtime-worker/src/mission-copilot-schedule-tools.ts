/**
 * The mission copilot's scheduling tools (Family D): create, cancel and list
 * this mission's `scheduled_messages`. Split from mission-copilot-tools.ts
 * when cancellation learned about file-backed schedules (ADR-0033 §3): a
 * schedule that came from `shared/schedules/<label>.json` is re-imported from
 * that file every minute, so cancelling it means removing the file.
 */

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { SCHEDULE_ORIGIN, storedCollection } from "@magi/agent-config";
import { Type } from "@sinclair/typebox";
import { type Db, ObjectId } from "mongodb";
import {
	resolveDeliverAt,
	scheduleInputProblem,
} from "./mission-copilot-schedule-input.js";
import { err, okJson } from "./mission-copilot-tool-result.js";
import { SCHEDULES_DIRNAME } from "./schedule-ingest.js";
import type { MagiTool } from "./tools.js";

interface ScheduleToolDeps {
	db: Db;
	missionId: string;
	sharedDir: string;
	auditPost: (subject: string, body: string) => Promise<void>;
}

function createScheduledMessageTool({
	db,
	missionId,
	auditPost,
}: ScheduleToolDeps): MagiTool {
	return {
		name: "CreateScheduledMessage",
		description:
			"Schedule a one-off or recurring wakeup message to one or more teammates. Provide either deliverAt (one-off, ISO timestamp) or cron (recurring, standard 5-field expression) — cron re-arms itself after each delivery. Posts an audit message to the user's mailbox.",
		parameters: Type.Object({
			to: Type.Array(Type.String(), { description: "Recipient agent ids" }),
			subject: Type.String(),
			body: Type.String(),
			deliverAt: Type.Optional(
				Type.String({ description: "ISO timestamp for a one-off delivery" }),
			),
			cron: Type.Optional(
				Type.String({
					description:
						"Standard 5-field cron expression for a recurring delivery",
				}),
			),
			label: Type.Optional(
				Type.String({ description: "Human-readable label" }),
			),
		}),
		async execute(_id, args) {
			const to = [...new Set(args.to as string[])];
			const subject = args.subject as string;
			const body = args.body as string;
			const cron = args.cron as string | undefined;
			const label = args.label as string | undefined;
			const invalid = await scheduleInputProblem(db, missionId, {
				to,
				subject,
				body,
				label,
			});
			if (invalid) return err(`CreateScheduledMessage: ${invalid}`);
			const when = resolveDeliverAt(args.deliverAt as string | undefined, cron);
			if ("error" in when) return err(`CreateScheduledMessage: ${when.error}`);
			const deliverAt = when.deliverAt;
			const result = await storedCollection(db, "scheduledMessages").insertOne({
				missionId,
				to,
				subject,
				body,
				deliverAt,
				cron,
				label,
				status: "pending",
			});
			await auditPost(
				"Scheduled a message",
				`I scheduled a message to ${to.join(", ")}: "${subject}"${cron ? ` (recurring: ${cron})` : ` (at ${deliverAt.toISOString()})`}.`,
			);
			return okJson({ ok: true, id: String(result.insertedId) });
		},
	};
}

function cancelScheduledMessageTool({
	db,
	missionId,
	sharedDir,
	auditPost,
}: ScheduleToolDeps): MagiTool {
	return {
		name: "CancelScheduledMessage",
		description:
			"Cancel a pending scheduled message. Posts an audit message to the user's mailbox.",
		parameters: Type.Object({
			id: Type.String({
				description: "Scheduled message id (from ListScheduledMessages)",
			}),
		}),
		async execute(_id, args) {
			const scheduleId = args.id as string;
			let objectId: ObjectId;
			try {
				objectId = new ObjectId(scheduleId);
			} catch {
				return err(`"${scheduleId}" is not a valid scheduled message id`);
			}
			const col = storedCollection(db, "scheduledMessages");
			const existing = await col.findOne({ _id: objectId, missionId });
			if (!existing) {
				return err(
					`No scheduled message "${scheduleId}" found in this mission`,
				);
			}
			if (existing.origin === SCHEDULE_ORIGIN && existing.label) {
				// A schedule that came from a file in shared/schedules/ is re-imported
				// from that file on the next tick, so the file has to go first; the
				// label was validated as a slug at ingestion, so it is safe as a path.
				const file = join(
					sharedDir,
					SCHEDULES_DIRNAME,
					`${existing.label}.json`,
				);
				try {
					unlinkSync(file);
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
						return err(
							`Could not remove ${file} (${(e as Error).message}); the schedule would be re-imported within a minute. Ask its author to rm the file.`,
						);
					}
				}
				await col.updateOne(
					{ _id: objectId, missionId },
					{ $set: { status: "cancelled", cancelledAt: new Date() } },
				);
			} else {
				await col.deleteOne({ _id: objectId, missionId });
			}
			await auditPost(
				"Cancelled a scheduled message",
				`I cancelled scheduled message ${scheduleId}${existing.label ? ` ("${existing.label}")` : ""}.`,
			);
			return okJson({ ok: true });
		},
	};
}

function listScheduledMessagesTool({
	db,
	missionId,
}: ScheduleToolDeps): MagiTool {
	return {
		name: "ListScheduledMessages",
		description: "List this mission's pending scheduled wakeups.",
		parameters: Type.Object({}),
		async execute() {
			const docs = await storedCollection(db, "scheduledMessages")
				.find({ missionId, status: "pending" })
				.sort({ deliverAt: 1 })
				.limit(50)
				.toArray();
			return okJson(
				docs.map((d) => ({
					id: String(d._id),
					kind: d.kind ?? "message",
					to: d.to,
					subject: d.subject,
					cron: d.cron ?? null,
					deliverAt: d.deliverAt,
					label: d.label ?? null,
					// "shared-schedules": defined by a file an agent wrote with the
					// schedule-task or run-background skill; cancelling removes that file.
					origin: d.origin ?? "copilot",
					createdBy: d.createdBy ?? null,
				})),
			);
		},
	};
}

export function createScheduleTools(deps: ScheduleToolDeps): {
	createScheduledMessage: MagiTool;
	cancelScheduledMessage: MagiTool;
	listScheduledMessages: MagiTool;
} {
	return {
		createScheduledMessage: createScheduledMessageTool(deps),
		cancelScheduledMessage: cancelScheduledMessageTool(deps),
		listScheduledMessages: listScheduledMessagesTool(deps),
	};
}
