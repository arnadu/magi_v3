/**
 * The soft-anomaly digest (#99/#100): soft anomalies are buffered and sent to
 * the mission copilot as one message per period, grouped by agent and kind,
 * instead of one wake-up each. The buffer is in memory; a restart drops an
 * unsent digest (every anomaly is still persisted in `missionAnomalies`).
 */

import type { AnomalyCategory, MissionAnomaly } from "@magi/agent-config";
import { anomalyDedupeKey } from "./anomaly.js";
import type { MailboxRepository } from "./mailbox.js";

interface DigestGroup {
	agentId?: string;
	category: AnomalyCategory;
	count: number;
	firstAt: number;
	lastAt: number;
	latest: string;
}

/** One message body summarising buffered soft anomalies, most frequent first. */
export function formatSoftDigest(groups: DigestGroup[]): string {
	const time = (ms: number) => new Date(ms).toISOString().slice(11, 16);
	const lines = [...groups]
		.sort((a, b) => b.count - a.count)
		.map(
			(g) =>
				`- ${g.agentId ?? "mission"} · ${g.category} ×${g.count} (${time(g.firstAt)}–${time(g.lastAt)} UTC). Latest: ${g.latest}`,
		);
	return `Soft anomalies since the last digest, grouped by agent and kind. None of them stopped a turn; assess whether any pattern needs intervention.\n\n${lines.join("\n")}`;
}

export interface SoftAnomalyDigest {
	add(anomaly: Omit<MissionAnomaly, "createdAt">): void;
}

/** The first digest is due one period after creation, then at most one per period, only when something arrived. */
export function createSoftAnomalyDigest(deps: {
	mailboxRepo: MailboxRepository;
	missionCopilotAgentId: string;
	periodMs: number;
	now: () => number;
}): SoftAnomalyDigest {
	const groups = new Map<string, DigestGroup>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastSentAt = deps.now();

	async function flush(missionId: string): Promise<void> {
		timer = undefined;
		lastSentAt = deps.now();
		if (groups.size === 0) return;
		const batch = [...groups.values()];
		groups.clear();
		const total = batch.reduce((n, g) => n + g.count, 0);
		try {
			await deps.mailboxRepo.post({
				missionId,
				from: "system",
				to: [deps.missionCopilotAgentId],
				subject: `Soft anomalies digest: ${total} in ${batch.length} group${batch.length === 1 ? "" : "s"}`,
				body: formatSoftDigest(batch),
			});
		} catch (e) {
			console.error(
				`[anomaly] Failed to post the soft-anomaly digest { missionId: ${missionId}, anomalies: ${total} } — they remain in missionAnomalies: ${(e as Error).message}`,
			);
		}
	}

	return {
		add(anomaly) {
			const key = anomalyDedupeKey(anomaly);
			const t = deps.now();
			const group = groups.get(key);
			if (group) {
				group.count++;
				group.lastAt = t;
				group.latest = anomaly.message;
			} else {
				groups.set(key, {
					agentId: anomaly.agentId,
					category: anomaly.category,
					count: 1,
					firstAt: t,
					lastAt: t,
					latest: anomaly.message,
				});
			}
			if (timer) return;
			timer = setTimeout(
				() => void flush(anomaly.missionId),
				Math.max(0, lastSentAt + deps.periodMs - t),
			);
			timer.unref?.();
		},
	};
}
