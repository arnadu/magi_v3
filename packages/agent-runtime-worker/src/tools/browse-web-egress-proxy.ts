/**
 * BrowseWeb egress-filtering proxy (issue CR-03 / F-002).
 *
 * Stagehand V3's custom CDP-based Page dropped Playwright's `page.route()`
 * request interception, which the original SSRF fix relied on. Without it,
 * the pre-navigation and post-redirect `isPrivateHost()` checks in
 * `browse-web.ts` only cover the initial `page.goto()` — once `agent()`
 * takes over (clicking links, following JS redirects, submitting forms,
 * opening popups), nothing checks where the browser goes next.
 *
 * Fix: launch Chromium with this loopback-only forward proxy as its
 * `--proxy-server` (via `localBrowserLaunchOptions.proxy`). Every CONNECT
 * (HTTPS) and every plain-HTTP request the browser makes is resolved and
 * checked against `isPrivateHost()` — the same check `browse-web.ts` already
 * runs — *before* the upstream connection opens, so it covers everything the
 * browser does, not just top-level navigation. No DNS-rebinding gap: DNS is
 * resolved here, once, immediately before connecting, never by the browser
 * itself (Chromium delegates DNS resolution to the configured proxy).
 *
 * No auth: this proxy is reachable only by the Chromium process this
 * handle's own BrowseWeb tool launches (bound to 127.0.0.1, an ephemeral
 * port never shared outside this process tree). It is a network-egress
 * control point, not a privilege boundary another process needs to be kept
 * out of — unlike ToolApiServer/MonitorServer, which are reachable by other
 * agent-controlled processes and therefore do need bearer-token auth.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { isPrivateHost } from "../ssrf.js";

export interface EgressProxyHandle {
	/** Pass as `localBrowserLaunchOptions.proxy.server` when launching Chromium. */
	url: string;
	close: () => Promise<void>;
}

/** IPv6-literal-aware split of a CONNECT target ("host:port" or "[::1]:443"). */
function splitHostPort(hostPort: string): { hostname: string; port: number } {
	if (hostPort.startsWith("[")) {
		const end = hostPort.indexOf("]");
		return {
			hostname: hostPort.slice(1, end),
			port: Number(hostPort.slice(end + 2)) || 443,
		};
	}
	const idx = hostPort.lastIndexOf(":");
	if (idx === -1) return { hostname: hostPort, port: 443 };
	return {
		hostname: hostPort.slice(0, idx),
		port: Number(hostPort.slice(idx + 1)) || 443,
	};
}

async function handleConnect(
	req: IncomingMessage,
	clientSocket: Duplex,
	head: Buffer,
	allowedHosts: string[],
	sockets: Set<Duplex | Socket>,
): Promise<void> {
	const { hostname, port } = splitHostPort(req.url ?? "");
	if (!hostname || (await isPrivateHost(hostname, allowedHosts))) {
		clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
		return;
	}
	const upstream = netConnect(port, hostname, () => {
		clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		upstream.write(head);
		upstream.pipe(clientSocket);
		clientSocket.pipe(upstream);
	});
	// A CONNECT tunnel hands the client socket off to raw TCP piping and opens
	// a second, brand-new outbound socket (`upstream`) that the http.Server
	// itself never knows about — closeAllConnections()/close() can't reach
	// either once this happens, so both are tracked here for explicit
	// destruction in the handle's own close() (see createEgressFilterProxy).
	sockets.add(clientSocket);
	sockets.add(upstream);
	const untrack = () => {
		sockets.delete(clientSocket);
		sockets.delete(upstream);
	};
	upstream.on("close", untrack);
	clientSocket.on("close", untrack);
	upstream.on("error", () => clientSocket.destroy());
	clientSocket.on("error", () => upstream.destroy());
}

async function handlePlainHttp(
	req: IncomingMessage,
	res: ServerResponse,
	allowedHosts: string[],
): Promise<void> {
	// A forward proxy receives plain-HTTP requests with an absolute-URI request
	// line (RFC 7230 §5.3.2), e.g. "GET http://example.com/path HTTP/1.1".
	let target: URL;
	try {
		target = new URL(req.url ?? "");
	} catch {
		res.writeHead(400).end("Bad Request — expected an absolute URI");
		return;
	}
	if (await isPrivateHost(target.hostname, allowedHosts)) {
		res.writeHead(403).end("Forbidden");
		return;
	}
	const upstreamReq = httpRequest(
		target,
		{ method: req.method, headers: req.headers },
		(upstreamRes) => {
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
			upstreamRes.pipe(res);
		},
	);
	upstreamReq.on("error", () => {
		if (!res.headersSent) res.writeHead(502);
		res.end();
	});
	req.pipe(upstreamReq);
}

/**
 * Starts the proxy on an ephemeral loopback port. Resolves once listening.
 * `allowedHosts` mirrors `isPrivateHost`'s own parameter — test infrastructure
 * only; production callers pass none.
 */
export function createEgressFilterProxy(
	allowedHosts: string[] = [],
): Promise<EgressProxyHandle> {
	return new Promise((resolve, reject) => {
		// Tracks every raw socket a CONNECT tunnel touches (both the inbound
		// client socket and our own outbound one) — see handleConnect's comment
		// on why the http.Server's own connection tracking can't reach these.
		const tunnelSockets = new Set<Duplex | Socket>();

		const server = createServer((req, res) => {
			handlePlainHttp(req, res, allowedHosts).catch((err) => {
				console.error("[browse-web-egress-proxy] request error:", err);
				if (!res.headersSent) res.writeHead(502);
				res.end();
			});
		});

		server.on("connect", (req, clientSocket, head) => {
			handleConnect(req, clientSocket, head, allowedHosts, tunnelSockets).catch(
				(err) => {
					console.error("[browse-web-egress-proxy] connect error:", err);
					clientSocket.destroy();
				},
			);
		});

		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("egress proxy: failed to bind a loopback port"));
				return;
			}
			resolve({
				url: `http://127.0.0.1:${addr.port}`,
				close: () => {
					// Never wait on server.close()'s own callback: a still-open CONNECT
					// tunnel (Chromium keeping a keepalive HTTPS connection open) can
					// leave it unresolved indefinitely — verified empirically, this
					// genuinely hung past 45s in testing, not just "slow." By the time
					// this runs, Chromium is already being torn down (browse-web.ts
					// awaits stagehand.close() first), so nothing legitimate still needs
					// these connections — destroy them all directly and return as soon
					// as that's done, regardless of what the server's own bookkeeping
					// thinks is still open.
					for (const sock of tunnelSockets) sock.destroy();
					tunnelSockets.clear();
					server.closeAllConnections();
					server.close();
					return Promise.resolve();
				},
			});
		});
	});
}
