import dns from "node:dns/promises";

/**
 * Matches loopback, private ranges, link-local, and cloud metadata addresses.
 * Applied to both the hostname string and the resolved IP address to catch
 * DNS rebinding attacks.
 */
export const PRIVATE_HOST_RE =
	/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|\[::1\]$|localhost$|0\.0\.0\.0$)/i;

/**
 * Returns true if the hostname resolves to a private or internal address.
 * Pass allowedHosts to exempt specific hosts (test infrastructure only).
 * DNS lookup failure is treated as not-private so valid hosts with transient
 * DNS issues are not silently blocked; the subsequent request will fail anyway.
 */
export async function isPrivateHost(
	hostname: string,
	allowedHosts: string[] = [],
): Promise<boolean> {
	if (allowedHosts.includes(hostname)) return false;
	if (PRIVATE_HOST_RE.test(hostname)) return true;
	try {
		const { address } = await dns.lookup(hostname);
		if (allowedHosts.includes(address)) return false;
		return PRIVATE_HOST_RE.test(address);
	} catch {
		// DNS failure — let the request fail naturally rather than silently blocking.
		return false;
	}
}
