import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for secrets (the monitor token). Both inputs
 * are HMAC'd to fixed-length digests first so `timingSafeEqual` never throws
 * or short-circuits on differing lengths. The "cmp" key is not a secret — it
 * only normalises lengths; the guarantee comes from `timingSafeEqual` over
 * equal-length buffers. Mirrors control-plane/src/auth.ts.
 */
export function safeEqual(a: string, b: string): boolean {
	// nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
	const ha = createHmac("sha256", "cmp").update(a).digest();
	// nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
	const hb = createHmac("sha256", "cmp").update(b).digest();
	return timingSafeEqual(ha, hb);
}

/**
 * The per-mission monitor token from the environment. On Fly (`FLY_APP_NAME`
 * set) it is mandatory: the monitor binds `::` and every machine in the app
 * can reach it over 6PN, so an empty token there would be an open server, not
 * "local dev mode". Off Fly an empty token disables the check (the developer's
 * own daemon on loopback).
 */
export function requireMonitorToken(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const token = env.MONITOR_TOKEN ?? "";
	if (!token && env.FLY_APP_NAME) {
		throw new Error(
			"MONITOR_TOKEN is required on Fly: the monitor server would otherwise accept every request from any machine in the app. The control plane injects it at machine creation from MONITOR_SIGNING_KEY — check that secret on the control plane.",
		);
	}
	return token;
}
