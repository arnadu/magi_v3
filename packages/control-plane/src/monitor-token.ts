import { createHmac } from "node:crypto";

/**
 * Derive a per-mission MONITOR_TOKEN using HMAC-SHA256.
 *
 * The token is unique per missionId — HMAC(MONITOR_SIGNING_KEY, missionId).
 * MONITOR_SIGNING_KEY lives only in the control plane's env (Fly secret);
 * it is never stored in MongoDB and never sent to execution plane machines.
 * Each machine receives its derived MONITOR_TOKEN at provision time via env.
 *
 * Returns empty string when MONITOR_SIGNING_KEY is not set (local dev: no auth).
 */
export function deriveMonitorToken(missionId: string): string {
	const key = process.env.MONITOR_SIGNING_KEY;
	if (!key) return "";
	return createHmac("sha256", key).update(missionId).digest("hex");
}
