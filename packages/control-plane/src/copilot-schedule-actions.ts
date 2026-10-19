/**
 * The two schedule actions of the copilot action registry, executed after
 * operator confirmation. Ownership goes through the mission (a schedule id is
 * a guessable ObjectId and the document carries no userId — EA1), recipients
 * are checked against the roster, a bare cron is first delivered at its next
 * occurrence (SCHED3), and "nothing was pending" is a failure, not a success.
 */

import { storedCollection } from "@magi/agent-config";
import cronParser from "cron-parser";
import { type Db, ObjectId } from "mongodb";
import type { ActionPayload } from "./copilot-actions.js";

const { parseExpression } = cronParser;

export async function executeCancelSchedule(
	db: Db,
	payload: ActionPayload<"cancel_schedule">,
	userId: string,
): Promise<string> {
	const missions = storedCollection(db, "missions");
	const scheduled = storedCollection(db, "scheduledMessages");
	const oid = new ObjectId(payload.id);
	const doc = await scheduled.findOne({ _id: oid });
	const owned =
		doc && (await missions.findOne({ missionId: doc.missionId, userId }));
	if (!doc || !owned) {
		throw new Error(`Scheduled message "${payload.id}" not found`);
	}
	const r = await scheduled.updateOne(
		{ _id: oid, status: "pending" },
		{ $set: { status: "cancelled" } },
	);
	if (r.matchedCount === 0) {
		throw new Error(
			`Scheduled message "${payload.id}" is already ${doc.status} — nothing to cancel`,
		);
	}
	return `Scheduled message "${payload.id}" cancelled`;
}

export async function executeCreateSchedule(
	db: Db,
	p: ActionPayload<"create_schedule">,
	userId: string,
	now: Date,
): Promise<string> {
	const missions = storedCollection(db, "missions");
	const mission = await missions.findOne({ missionId: p.missionId, userId });
	if (!mission) throw new Error(`Mission "${p.missionId}" not found`);
	const roster = mission.agents?.map((a) => a.id);
	if (roster) {
		const allowed = new Set([...roster, "user", "mission-copilot"]);
		const unknown = p.to.filter((t) => !allowed.has(t));
		if (unknown.length) {
			throw new Error(
				`create_schedule: unknown recipient(s) ${unknown.join(", ")} — mission "${p.missionId}" has agents ${roster.join(", ")}`,
			);
		}
	}
	const deliverAt = p.deliverAt
		? new Date(p.deliverAt)
		: parseExpression(p.cron as string)
				.next()
				.toDate();
	const r = await storedCollection(db, "scheduledMessages").insertOne({
		missionId: p.missionId,
		to: p.to,
		subject: p.subject,
		body: p.body,
		deliverAt,
		cron: p.cron,
		label: p.label,
		status: "pending",
		createdBy: userId,
		createdAt: now,
	});
	return `Scheduled message ${r.insertedId.toHexString()} created for mission "${p.missionId}" — first delivery ${deliverAt.toISOString()}${p.cron ? `, then cron ${p.cron}` : ""}`;
}
