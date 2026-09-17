/**
 * Unit tests for the BrowseWeb egress-filtering proxy (issue CR-03 / F-002).
 *
 * No Chromium, no LLM — just raw HTTP/CONNECT clients exercising the proxy
 * directly, proving it blocks private/internal targets and forwards allowed
 * ones, for both the CONNECT (HTTPS) and plain-HTTP forward-proxy paths.
 */

import type { Server } from "node:http";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	createEgressFilterProxy,
	type EgressProxyHandle,
} from "../src/tools/browse-web-egress-proxy.js";

/**
 * Sends a raw CONNECT request over a plain TCP socket and resolves with the
 * proxy's status line. Deliberately not using Node's http client for CONNECT
 * — its handling of a non-2xx (non-upgraded) CONNECT response is not
 * consistent enough across Node versions to rely on here.
 */
function rawConnect(
	proxyUrl: string,
	targetHostPort: string,
): Promise<{ statusCode: number }> {
	const proxy = new URL(proxyUrl);
	return new Promise((resolve, reject) => {
		const sock = netConnect(Number(proxy.port), proxy.hostname, () => {
			sock.write(
				`CONNECT ${targetHostPort} HTTP/1.1\r\nHost: ${targetHostPort}\r\n\r\n`,
			);
		});
		let buf = "";
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const match = buf.match(/^HTTP\/1\.[01] (\d{3})/);
			if (match) {
				resolve({ statusCode: Number(match[1]) });
				sock.destroy();
			}
		});
		sock.on("error", reject);
		sock.on("close", () => {
			if (!buf) reject(new Error("connection closed with no response"));
		});
	});
}

function startUpstream(): Promise<{ port: number; server: Server }> {
	return new Promise((resolve) => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("upstream ok");
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") throw new Error("bind failed");
			resolve({ port: addr.port, server });
		});
	});
}

describe("BrowseWeb egress-filtering proxy", () => {
	let upstreamPort: number;
	let upstreamServer: Server;
	let handle: EgressProxyHandle;

	beforeAll(async () => {
		const u = await startUpstream();
		upstreamPort = u.port;
		upstreamServer = u.server;
	});

	afterAll(() => {
		upstreamServer.close();
	});

	afterEach(async () => {
		await handle?.close();
	});

	it("rejects a CONNECT to a private-range target with 403", async () => {
		handle = await createEgressFilterProxy([]);
		const result = await rawConnect(handle.url, `127.0.0.1:${upstreamPort}`);
		expect(result.statusCode).toBe(403);
	});

	it("allows a CONNECT to an explicitly allowlisted host", async () => {
		handle = await createEgressFilterProxy(["127.0.0.1"]);
		const result = await rawConnect(handle.url, `127.0.0.1:${upstreamPort}`);
		expect(result.statusCode).toBe(200);
	});

	it("rejects a CONNECT to a distinct private loopback address not on the allowlist", async () => {
		// 127.0.0.2 is still loopback (matches PRIVATE_HOST_RE's ^127\.) but is a
		// different address than the one allowlisted for the "safe" server —
		// mirrors the real attack shape: the start page is allowed, a link on it
		// points somewhere else private that must still be blocked.
		handle = await createEgressFilterProxy(["127.0.0.1"]);
		const result = await rawConnect(handle.url, "127.0.0.2:9");
		expect(result.statusCode).toBe(403);
	});

	it("plain-HTTP forward-proxy path: rejects a private target", async () => {
		handle = await createEgressFilterProxy([]);
		const proxy = new URL(handle.url);
		const statusCode = await new Promise<number>((resolve, reject) => {
			const req = httpRequest(
				{
					host: proxy.hostname,
					port: proxy.port,
					method: "GET",
					path: `http://127.0.0.1:${upstreamPort}/`,
				},
				(res) => resolve(res.statusCode ?? 0),
			);
			req.on("error", reject);
			req.end();
		});
		expect(statusCode).toBe(403);
	});

	it("plain-HTTP forward-proxy path: forwards an allowlisted target's response", async () => {
		handle = await createEgressFilterProxy(["127.0.0.1"]);
		const proxy = new URL(handle.url);
		const body = await new Promise<string>((resolve, reject) => {
			const req = httpRequest(
				{
					host: proxy.hostname,
					port: proxy.port,
					method: "GET",
					path: `http://127.0.0.1:${upstreamPort}/`,
				},
				(res) => {
					let data = "";
					res.on("data", (c) => {
						data += c;
					});
					res.on("end", () => resolve(data));
				},
			);
			req.on("error", reject);
			req.end();
		});
		expect(body).toBe("upstream ok");
	});

	it("close() resolves promptly even with a CONNECT tunnel still open (regression: previously hung indefinitely)", async () => {
		handle = await createEgressFilterProxy(["127.0.0.1"]);
		const proxy = new URL(handle.url);

		// Open a CONNECT tunnel and deliberately leave it open — simulates
		// Chromium holding a keepalive HTTPS connection through the proxy when
		// close() is called. The http.Server hands this socket off to raw TCP
		// piping (see handleConnect), so its own connection tracking /
		// closeAllConnections() can't reach it — only the explicit socket
		// tracking in createEgressFilterProxy can.
		await new Promise<void>((resolve, reject) => {
			const sock = netConnect(Number(proxy.port), proxy.hostname, () => {
				sock.write(
					`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`,
				);
			});
			sock.on("data", (chunk) => {
				if (/^HTTP\/1\.[01] 200/.test(chunk.toString("utf8"))) resolve();
			});
			sock.on("error", reject);
			// Deliberately not destroyed — left open, unref'd so it doesn't keep
			// the test process itself alive.
			sock.unref();
		});

		const start = Date.now();
		await handle.close();
		expect(Date.now() - start).toBeLessThan(2_000);
	});

	it("close() stops the server — further connections are refused", async () => {
		handle = await createEgressFilterProxy([]);
		const url = handle.url;
		await handle.close();
		const port = Number(new URL(url).port);
		await expect(
			new Promise((resolve, reject) => {
				const sock = netConnect(port, "127.0.0.1");
				sock.on("connect", () => {
					sock.destroy();
					resolve(undefined);
				});
				sock.on("error", reject);
			}),
		).rejects.toThrow();
	});
});
