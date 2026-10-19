/** Messages, anomalies and renewal reminders around machine upgrades (ADR-0031). */

import {
	type MissionDoc,
	type MissionUpgradeState,
	storedCollection,
} from "@magi/agent-config";
import {
	createMongoAlertStateStore,
	createMongoAnomalyRecorderForMission,
	evaluateAlert,
	MISSION_COPILOT_AGENT_ID,
	UPGRADE_LIMITS,
} from "@magi/agent-runtime-worker";
import { type Db, ObjectId } from "mongodb";
import type { MachineShape } from "./machine-shapes.js";
import { postMailbox } from "./mailbox-writer.js";

const MINUTE = 60_000;
const _HOUR = 60 * MINUTE;
// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Agent-authored text is cut and stripped before it reaches an operator or a copilot. */
export function sanitizeReason(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const cleaned = Array.from(raw, (ch) => {
		const code = ch.charCodeAt(0);
		return code < 0x20 || code === 0x7f ? " " : ch;
	})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
	const max = UPGRADE_LIMITS.reasonMaxChars;
	return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

export function describeShape(s: MachineShape): string {
	const gb = s.memoryMb / 1024;
	return `${s.cpuKind}, ${s.cpus} CPU${s.cpus === 1 ? "" : "s"}, ${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB RAM`;
}

export const utc = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;

// ---------------------------------------------------------------------------
// Notifications and reminders
// ---------------------------------------------------------------------------

export async function post(
	db: Db,
	missionId: string,
	to: string[],
	subject: string,
	body: string,
): Promise<void> {
	await postMailbox(db, { missionId, from: "system", to, subject, body });
}

/** Tell the operator, the mission-copilot and (if any) the requesting agent; best-effort. */
export async function notify(
	db: Db,
	mission: MissionDoc,
	requester: string | undefined,
	subject: string,
	body: string,
): Promise<void> {
	try {
		await post(
			db,
			mission.missionId,
			["user", MISSION_COPILOT_AGENT_ID, ...(requester ? [requester] : [])],
			subject,
			body,
		);
	} catch (e) {
		console.error(
			`[resource-upgrade] Failed to post notification { missionId: "${mission.missionId}", error: "${(e as Error).message}" }`,
		);
	}
}

export async function recordAnomaly(
	db: Db,
	mission: MissionDoc,
	category: "upgrade-cap-reached" | "resize-failure",
	message: string,
): Promise<void> {
	await createMongoAnomalyRecorderForMission(
		db,
		mission.missionId,
		mission.userId,
	).record({
		missionId: mission.missionId,
		category,
		severity: "hard",
		message,
	});
}

/**
 * `upgrade-cap-reached` is raised at most once per 24 h per mission, so an
 * agent that keeps retrying a rejected request cannot flood the control-plane
 * copilot. (The operator's reset clears this state.)
 */
export async function recordCapReached(
	db: Db,
	mission: MissionDoc,
	message: string,
): Promise<void> {
	const level = await evaluateAlert(
		createMongoAlertStateStore(db),
		`${mission.missionId}:upgrade-cap-reached`,
		1,
		{ soft: 1, hard: 1 },
	);
	if (level === null) return;
	await recordAnomaly(db, mission, "upgrade-cap-reached", message).catch(
		() => {},
	);
}

/** Deliver the renewal reminder to the mission-copilot and the requester, before the window ends. */
export async function scheduleReminder(
	db: Db,
	mission: MissionDoc,
	upgrade: MissionUpgradeState,
	now: Date,
): Promise<string | undefined> {
	const windowMs = upgrade.expiresAt.getTime() - now.getTime();
	const beforeExpiry =
		upgrade.expiresAt.getTime() - UPGRADE_LIMITS.reminderBufferMinutes * MINUTE;
	// A window shorter than the buffer would put the reminder in the past.
	const deliverAt = new Date(
		Math.max(beforeExpiry, now.getTime() + windowMs / 2),
	);
	const to = [
		MISSION_COPILOT_AGENT_ID,
		...(upgrade.requestedByAgentId ? [upgrade.requestedByAgentId] : []),
	];
	try {
		const r = await storedCollection(db, "scheduledMessages").insertOne({
			missionId: mission.missionId,
			to,
			subject: "Machine upgrade expires soon",
			body: `The temporary machine upgrade (${describeShape(upgrade)}) expires at ${utc(upgrade.expiresAt)}. When it does the machine reverts to the default: running agent turns are interrupted and background jobs re-run from scratch. If the work still needs it, the mission-copilot decides whether to renew (after asking ${upgrade.requestedByAgentId ?? "the agent that needed it"} if the job is done) by calling RequestResourceUpgrade again with the same shape; otherwise no action is needed.`,
			deliverAt,
			label: "machine-upgrade-reminder",
			status: "pending",
		});
		return String(r.insertedId);
	} catch (e) {
		console.error(
			`[resource-upgrade] Failed to schedule reminder { missionId: "${mission.missionId}", error: "${(e as Error).message}" }`,
		);
		return undefined;
	}
}

export async function cancelReminder(
	db: Db,
	missionId: string,
	reminderId: string | undefined,
): Promise<void> {
	if (!reminderId || !ObjectId.isValid(reminderId)) return;
	await storedCollection(db, "scheduledMessages")
		.deleteOne({ _id: new ObjectId(reminderId), missionId })
		.catch((e: unknown) =>
			console.error(
				`[resource-upgrade] Failed to cancel reminder { missionId: "${missionId}", error: "${(e as Error).message}" }`,
			),
		);
}
