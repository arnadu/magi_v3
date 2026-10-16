/**
 * Outbound HTTP for content the daemon fetches on an agent's behalf (FetchUrl
 * and its image downloads). Built on `http.request` rather than `fetch` for
 * three properties `fetch` cannot give here:
 *
 * - every hop is vetted: redirects are followed manually (at most
 *   MAX_REDIRECTS), each target goes through `resolveVetted` first, and the
 *   socket is opened to the vetted address via the `lookup` option — the name
 *   is never resolved a second time by the client (S2/S3/FU3);
 * - the body is capped while streaming: a chunked response with no
 *   Content-Length is aborted the moment it passes `maxBytes`, not buffered
 *   first (FU1 — a 400 MB page previously added ~400 MB of RSS);
 * - a hard timeout covers connect, headers and body (FU4).
 */

import type { IncomingHttpHeaders } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { resolvePinned, SsrfBlockedError } from "./ssrf.js";

export const MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 30_000;

export class ResponseTooLargeError extends Error {
	override readonly name = "ResponseTooLargeError";
	constructor(
		readonly maxBytes: number,
		readonly seen: number | null,
	) {
		super(
			seen === null
				? `Response exceeds the ${maxBytes} byte limit`
				: `Response too large: ${seen} bytes exceeds the ${maxBytes} byte limit`,
		);
	}
}

export interface SafeGetOptions {
	/** Hard cap on body bytes; enforced on Content-Length and while streaming. */
	maxBytes: number;
	/** Overall deadline for connect + headers + body. Default 30 s. */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Test infrastructure only — see ssrf.ts. */
	allowedHosts?: string[];
	headers?: Record<string, string>;
}

export interface SafeGetResult {
	status: number;
	headers: IncomingHttpHeaders;
	bytes: Buffer;
	/** The URL that actually answered, after redirects. */
	finalUrl: URL;
}

function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
	// http.request resolves one address per socket; hand it the vetted one.
	return (_hostname, _options, callback) => callback(null, address, family);
}

/**
 * GET `url` with every hop vetted and pinned. Resolves with the final
 * response (any status; the caller decides what a 404 means). Rejects with
 * `SsrfBlockedError`, `ResponseTooLargeError`, a timeout, or the socket error.
 */
export async function safeGet(
	input: URL | string,
	opts: SafeGetOptions,
): Promise<SafeGetResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	let url = typeof input === "string" ? new URL(input) : input;

	for (let hop = 0; ; hop++) {
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new SsrfBlockedError(
				url.href,
				`unsupported protocol ${url.protocol}`,
			);
		}
		const pinned = await resolvePinned(url.hostname, opts.allowedHosts);
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(`Timed out after ${timeoutMs} ms`);

		const res = await oneRequest(url, pinned, {
			...opts,
			timeoutMs: remaining,
		});
		const location = res.headers.location;
		if (
			res.status >= 300 &&
			res.status < 400 &&
			typeof location === "string" &&
			location
		) {
			if (hop >= MAX_REDIRECTS) {
				throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
			}
			let next: URL;
			try {
				next = new URL(location, url);
			} catch {
				throw new Error(`Redirect to an invalid URL: ${location}`);
			}
			url = next;
			continue;
		}
		return { ...res, finalUrl: url };
	}
}

function oneRequest(
	url: URL,
	pinned: { address: string; family: 4 | 6 },
	opts: SafeGetOptions & { timeoutMs: number },
): Promise<Omit<SafeGetResult, "finalUrl">> {
	return new Promise((resolve, reject) => {
		const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
			method: "GET",
			headers: { "user-agent": "MAGI-FetchUrl/1.0", ...(opts.headers ?? {}) },
			lookup: pinnedLookup(pinned.address, pinned.family),
			signal: opts.signal,
			timeout: opts.timeoutMs,
		});
		const timer = setTimeout(() => {
			req.destroy(new Error(`Timed out after ${opts.timeoutMs} ms`));
		}, opts.timeoutMs);
		const finish = (fn: () => void) => {
			clearTimeout(timer);
			fn();
		};
		req.on("timeout", () => req.destroy(new Error("Socket timed out")));
		req.on("error", (e) => finish(() => reject(e)));
		req.on("response", (res) => {
			const declared = Number(res.headers["content-length"] ?? "0");
			if (declared > opts.maxBytes) {
				res.destroy();
				req.destroy();
				finish(() =>
					reject(new ResponseTooLargeError(opts.maxBytes, declared)),
				);
				return;
			}
			const chunks: Buffer[] = [];
			let seen = 0;
			res.on("data", (chunk: Buffer) => {
				seen += chunk.length;
				if (seen > opts.maxBytes) {
					res.destroy();
					req.destroy();
					finish(() => reject(new ResponseTooLargeError(opts.maxBytes, null)));
					return;
				}
				chunks.push(chunk);
			});
			res.on("error", (e) => finish(() => reject(e)));
			res.on("end", () =>
				finish(() =>
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						bytes: Buffer.concat(chunks),
					}),
				),
			);
		});
		req.end();
	});
}
