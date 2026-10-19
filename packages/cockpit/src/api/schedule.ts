import { api, mp, request } from "./http";

export interface ScheduledMessage {
	id: string;
	to: string[];
	subject: string;
	cronExpression: string | null;
	scheduledFor: string | null;
}

export function fetchSchedule(missionId: string): Promise<ScheduledMessage[]> {
	return api<ScheduledMessage[]>(`/missions/${mp(missionId)}/schedule`);
}

export async function cancelScheduledMessage(
	missionId: string,
	id: string,
): Promise<void> {
	const res = await request(`/missions/${mp(missionId)}/schedule/${mp(id)}`, {
		method: "DELETE",
		credentials: "include",
	});
	if (!res.ok)
		throw new Error(`HTTP ${res.status} cancelling scheduled message`);
}

// ── Daemon log — ported from index.html's log-viewer modal ─────────────────

export async function fetchDaemonLog(
	missionId: string,
	lines = 300,
): Promise<string> {
	const res = await request(`/missions/${mp(missionId)}/log?lines=${lines}`, {
		credentials: "include",
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} fetching log`);
	return res.text();
}

// ── Mission/agent config editor — ported from index.html's renderConfigForm.
