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

/**
 * Request headers for any control-plane → monitor-server call. Every monitor
 * route requires the token (GETs included); when no signing key is configured
 * (local dev with a loopback daemon) the header is simply absent.
 */
export function monitorAuthHeaders(missionId: string): Record<string, string> {
	const token = deriveMonitorToken(missionId);
	return token ? { "x-monitor-token": token } : {};
}

/**
 * A mission machine's monitor URL. IPv6 (Fly 6PN) needs brackets; an IPv4
 * address (a local developer daemon) must not have them — `http://[127.0.0.1]`
 * is an invalid URL, which a best-effort catch used to hide (MIS1).
 */
export function monitorUrl(privateIp: string, path: string): string {
	const host = privateIp.includes(":") ? `[${privateIp}]` : privateIp;
	return `http://${host}:4000${path}`;
}
