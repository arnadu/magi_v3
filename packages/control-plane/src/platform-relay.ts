/**
 * Platform-level alerts (no mission to attach them to) go straight into each
 * platform admin's control-plane copilot inbox. `AnomalyRecorder` is always
 * mission-scoped, so the cross-cutting checks (Atlas storage, orphan
 * machines) post here instead. Field shape must match `MailboxMessage`
 * (agent-runtime-worker/src/mailbox.ts) — `timestamp`/`readBy`, not
 * `createdAt`/`read` — because the copilot's prompt builder reads
 * `timestamp.toISOString()` unconditionally.
 */

import type { Db } from "mongodb";
import { postMailbox } from "./mailbox-writer.js";

export async function relayToPlatformAdmins(
	db: Db,
	platformAdminUserIds: readonly string[],
	alert: { category: string; body: string; now?: Date },
): Promise<void> {
	const _timestamp = alert.now ?? new Date();
	for (const userId of platformAdminUserIds) {
		try {
			await postMailbox(db, {
				missionId: `copilot-${userId}`,
				from: "system",
				to: ["copilot"],
				subject: `Anomaly (hard): ${alert.category}`,
				body: alert.body,
			});
		} catch (e) {
			console.error(
				`[platform-relay] Failed to relay ${alert.category} to admin { userId: "${userId}", error: "${(e as Error).message}" } — that admin will not see this alert`,
			);
		}
	}
}
