/**
 * safe-http.ts against a real local server: vetted + pinned hops, redirect
 * handling, streaming byte cap, timeout (audit 2026-10: S2, S3, FU1, FU3, FU4).
 * 127.0.0.1 is allowlisted as the test upstream; 127.0.0.2 is a distinct
 * loopback address that is NOT allowlisted and stands in for an internal target.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResponseTooLargeError, safeGet } from "../src/safe-http.js";
import { SsrfBlockedError } from "../src/ssrf.js";

let server: Server;
let base: string;
const ALLOW = ["127.0.0.1"];

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		switch (url.pathname) {
			case "/ok":
				res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
				res.end("hello");
				return;
			case "/to-ok":
				res.writeHead(302, { location: "/ok" });
				res.end();
				return;
			case "/to-internal":
				res.writeHead(302, {
					location: `http://127.0.0.2:${req.headers.host?.split(":")[1] ?? "80"}/ok`,
				});
				res.end();
				return;
			case "/to-localhost":
				res.writeHead(301, { location: "http://localhost/admin" });
				res.end();
				return;
			case "/loop":
				res.writeHead(302, { location: "/loop" });
				res.end();
				return;
			case "/big-declared":
				res.writeHead(200, { "content-length": "999999999" });
				res.end();
				return;
			case "/big-chunked": {
				res.writeHead(200, { "content-type": "application/octet-stream" });
				const chunk = Buffer.alloc(64 * 1024, 1);
				let sent = 0;
				const push = () => {
					while (sent < 8 * 1024 * 1024) {
						sent += chunk.length;
						if (!res.write(chunk)) {
							res.once("drain", push);
							return;
						}
					}
					res.end();
				};
				push();
				return;
			}
			case "/slow":
				// never answers
				return;
			default:
				res.writeHead(404);
				res.end();
		}
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("bind failed");
	base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((r) => server.close(() => r()));
});

describe("safeGet", () => {
	it("fetches a plain response and reports the final URL", async () => {
		const r = await safeGet(`${base}/ok`, {
			maxBytes: 1024,
			allowedHosts: ALLOW,
		});
		expect(r.status).toBe(200);
		expect(r.bytes.toString()).toBe("hello");
		expect(r.finalUrl.pathname).toBe("/ok");
	});

	it("follows a same-host redirect and re-validates the target", async () => {
		const r = await safeGet(`${base}/to-ok`, {
			maxBytes: 1024,
			allowedHosts: ALLOW,
		});
		expect(r.status).toBe(200);
		expect(r.finalUrl.pathname).toBe("/ok");
	});

	it("refuses a redirect to an address that is not vetted (loopback not on the allowlist)", async () => {
		await expect(
			safeGet(`${base}/to-internal`, { maxBytes: 1024, allowedHosts: ALLOW }),
		).rejects.toBeInstanceOf(SsrfBlockedError);
	});

	it("refuses a redirect to an internal hostname without resolving it", async () => {
		await expect(
			safeGet(`${base}/to-localhost`, { maxBytes: 1024, allowedHosts: ALLOW }),
		).rejects.toThrow(/internal hostname/);
	});

	it("gives up after too many redirects", async () => {
		await expect(
			safeGet(`${base}/loop`, { maxBytes: 1024, allowedHosts: ALLOW }),
		).rejects.toThrow(/Too many redirects/);
	});

	it("rejects an oversize Content-Length before reading a body", async () => {
		await expect(
			safeGet(`${base}/big-declared`, { maxBytes: 1024, allowedHosts: ALLOW }),
		).rejects.toBeInstanceOf(ResponseTooLargeError);
	});

	it("aborts a chunked body the moment it passes the cap instead of buffering it", async () => {
		const before = process.memoryUsage().rss;
		await expect(
			safeGet(`${base}/big-chunked`, {
				maxBytes: 256 * 1024,
				allowedHosts: ALLOW,
			}),
		).rejects.toBeInstanceOf(ResponseTooLargeError);
		// 8 MB would be served; far less than that should have been retained.
		expect(process.memoryUsage().rss - before).toBeLessThan(6 * 1024 * 1024);
	});

	it("times out a server that never answers", async () => {
		await expect(
			safeGet(`${base}/slow`, {
				maxBytes: 1024,
				allowedHosts: ALLOW,
				timeoutMs: 300,
			}),
		).rejects.toThrow(/Timed out|timed out/);
	});

	it("refuses non-http(s) schemes and private literals up front", async () => {
		await expect(
			safeGet("ftp://93.184.216.34/x", { maxBytes: 1 }),
		).rejects.toBeInstanceOf(SsrfBlockedError);
		await expect(
			safeGet("http://169.254.169.254/latest/meta-data", { maxBytes: 1 }),
		).rejects.toBeInstanceOf(SsrfBlockedError);
		await expect(
			safeGet("http://[::ffff:127.0.0.1]/", { maxBytes: 1 }),
		).rejects.toBeInstanceOf(SsrfBlockedError);
	});
});
