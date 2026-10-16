/**
 * Which hosts the daemon may open outbound connections to on an agent's (or a
 * web page's) behalf — FetchUrl, BrowseWeb's egress proxy, image fetches.
 *
 * "Private" means anything that is not the public internet: loopback, RFC 1918,
 * link-local (including the cloud metadata address), CGNAT, ULA (Fly's 6PN
 * mesh is `fdaa::/16`), multicast, the unspecified address, and the IPv6 forms
 * that embed an IPv4 address (`::ffff:a.b.c.d`, its hex spelling, NAT64,
 * 6to4) — the audit (S1/B1b) showed `[::ffff:127.0.0.1]` and
 * `[::ffff:a9fe:a9fe]` walking past a regex that only knew dotted quads.
 * Hostnames are classified by every address they resolve to, not the first,
 * and a lookup failure counts as private: the fetch would fail anyway, and
 * fail-open is how a flaky resolver becomes a bypass.
 *
 * `resolvePinned` is the companion for callers that then connect: it returns
 * the vetted address so the socket is opened to exactly what was checked,
 * instead of letting the HTTP client resolve the name a second time (S3,
 * DNS rebinding).
 *
 * `allowedHosts` is test infrastructure only (a local server on 127.0.0.1);
 * production callers pass none.
 */

import dns from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

export class SsrfBlockedError extends Error {
	override readonly name = "SsrfBlockedError";
	constructor(
		readonly host: string,
		reason: string,
	) {
		super(
			`Requests to private/internal addresses are not permitted (${host}: ${reason})`,
		);
	}
}

/** Hostname suffixes that never denote the public internet. */
const PRIVATE_NAME_RE = /(^|\.)(localhost|internal|local|home\.arpa)$/i;

function ipv4ToInt(ip: string): number {
	const [a, b, c, d] = ip.split(".").map(Number);
	return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

function inCidr4(ip: number, base: string, bits: number): boolean {
	const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
	return (ip & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
}

/** True for any IPv4 address outside the public unicast space. */
export function isPrivateIPv4(ip: string): boolean {
	const n = ipv4ToInt(ip);
	return (
		inCidr4(n, "0.0.0.0", 8) || // "this" network, incl. 0.0.0.0
		inCidr4(n, "10.0.0.0", 8) ||
		inCidr4(n, "100.64.0.0", 10) || // CGNAT
		inCidr4(n, "127.0.0.0", 8) ||
		inCidr4(n, "169.254.0.0", 16) || // link-local, cloud metadata
		inCidr4(n, "172.16.0.0", 12) ||
		inCidr4(n, "192.0.0.0", 24) || // IETF protocol assignments
		inCidr4(n, "192.168.0.0", 16) ||
		inCidr4(n, "198.18.0.0", 15) || // benchmarking
		inCidr4(n, "224.0.0.0", 4) || // multicast
		inCidr4(n, "240.0.0.0", 4) // reserved + broadcast
	);
}

/** Expand an IPv6 literal to its eight 16-bit groups, or null when malformed. */
export function ipv6Groups(ip: string): number[] | null {
	let s = ip.trim();
	if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
	const zone = s.indexOf("%");
	if (zone !== -1) s = s.slice(0, zone);
	if (!isIPv6(s)) return null;
	// Embedded dotted IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4).
	const lastColon = s.lastIndexOf(":");
	const tail = s.slice(lastColon + 1);
	if (tail.includes(".")) {
		if (!isIPv4(tail)) return null;
		const n = ipv4ToInt(tail);
		s = `${s.slice(0, lastColon)}:${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
	}
	const halves = s.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
	if (fill < 0 || head.length + rest.length + fill !== 8) return null;
	const groups = [...head, ...Array(fill).fill("0"), ...rest].map((g) =>
		Number.parseInt(g, 16),
	);
	return groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)
		? null
		: groups;
}

/** The IPv4 address an IPv6 literal embeds (mapped, NAT64 well-known prefix, 6to4), if any. */
function embeddedIPv4(g: number[]): string | null {
	const v4 = (hi: number, lo: number) =>
		`${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
	// ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (deprecated IPv4-compatible)
	if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0) {
		if (g[5] === 0xffff || (g[5] === 0 && (g[6] !== 0 || g[7] > 1))) {
			return v4(g[6], g[7]);
		}
	}
	// 64:ff9b::/96 (NAT64) and 64:ff9b:1::/48 (local-use NAT64)
	if (g[0] === 0x64 && g[1] === 0xff9b) return v4(g[6], g[7]);
	// 2002::/16 (6to4): the v4 address is groups 1-2
	if (g[0] === 0x2002) return v4(g[1], g[2]);
	return null;
}

/** True for any IPv6 address outside the public unicast space. */
export function isPrivateIPv6(ip: string): boolean {
	const g = ipv6Groups(ip);
	if (!g) return true; // malformed: never connect to it
	const embedded = embeddedIPv4(g);
	if (embedded) return isPrivateIPv4(embedded);
	const all0 = g.every((x) => x === 0);
	if (all0) return true; // ::
	if (all0 || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return true; // ::1
	if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA (Fly 6PN is fdaa::/16)
	if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
	if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
	return false;
}

/** True when `address` (a literal IPv4 or IPv6, brackets allowed) is not public. */
export function isPrivateAddress(address: string): boolean {
	const bare = address.replace(/^\[|\]$/g, "");
	if (isIPv4(bare)) return isPrivateIPv4(bare);
	return isPrivateIPv6(bare);
}

function normaliseHostname(hostname: string): string {
	return hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/, "")
		.toLowerCase();
}

/**
 * Every address `hostname` denotes: the literal itself, or all of its DNS
 * answers (A and AAAA). Throws `SsrfBlockedError` when any of them is private,
 * when the name is a private-only name, or when resolution fails.
 */
export async function resolveVetted(
	hostname: string,
	allowedHosts: string[] = [],
): Promise<Array<{ address: string; family: 4 | 6 }>> {
	const host = normaliseHostname(hostname);
	if (allowedHosts.includes(host) || allowedHosts.includes(hostname)) {
		return isIPv4(host) || isIPv6(host)
			? [{ address: host, family: isIPv4(host) ? 4 : 6 }]
			: (await dns.lookup(host, { all: true })).map((a) => ({
					address: a.address,
					family: a.family as 4 | 6,
				}));
	}
	if (isIPv4(host) || isIPv6(host)) {
		if (isPrivateAddress(host))
			throw new SsrfBlockedError(hostname, "private address");
		return [{ address: host, family: isIPv4(host) ? 4 : 6 }];
	}
	if (!host || PRIVATE_NAME_RE.test(host)) {
		throw new SsrfBlockedError(hostname, "internal hostname");
	}
	let answers: Array<{ address: string; family: number }>;
	try {
		answers = await dns.lookup(host, { all: true });
	} catch (e) {
		throw new SsrfBlockedError(
			hostname,
			`DNS lookup failed (${(e as Error).message}); refusing rather than guessing`,
		);
	}
	const list = answers;
	if (list.length === 0) throw new SsrfBlockedError(hostname, "no DNS answers");
	for (const a of list) {
		if (allowedHosts.includes(a.address)) continue;
		if (isPrivateAddress(a.address)) {
			throw new SsrfBlockedError(
				hostname,
				`resolves to private address ${a.address}`,
			);
		}
	}
	return list.map((a) => ({ address: a.address, family: a.family as 4 | 6 }));
}

/** The one address to connect to for `hostname`, after `resolveVetted`. */
export async function resolvePinned(
	hostname: string,
	allowedHosts: string[] = [],
): Promise<{ address: string; family: 4 | 6 }> {
	const [first] = await resolveVetted(hostname, allowedHosts);
	return first;
}

/**
 * Boolean form of `resolveVetted` for callers that only need yes/no (the
 * pre-navigation checks). A lookup failure is "private" here too.
 */
export async function isPrivateHost(
	hostname: string,
	allowedHosts: string[] = [],
): Promise<boolean> {
	try {
		await resolveVetted(hostname, allowedHosts);
		return false;
	} catch {
		return true;
	}
}

/**
 * Synchronous classification of a host string without DNS: true for a private
 * literal address or an internal-only name (`localhost`, `*.internal`, …),
 * false for anything that would need a lookup to decide. The pre-flight check
 * tools can run before any network activity; the authoritative decision is
 * `resolveVetted`.
 */
export function isPrivateLiteral(host: string): boolean {
	const h = normaliseHostname(host);
	if (!h) return true;
	if (isIPv4(h) || isIPv6(h)) return isPrivateAddress(h);
	return PRIVATE_NAME_RE.test(h);
}
