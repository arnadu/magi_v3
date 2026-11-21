import {
	createServer,
	type IncomingHttpHeaders,
	request,
	type Server,
} from "node:http";
import { type AddressInfo, connect } from "node:net";
import {
	type AppGrant,
	deriveAppsToken,
	signAppSession,
	signAppTicket,
} from "@magi/agent-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fetchSiteAllowed,
	rewriteSetCookies,
	sessionCookies,
	slotOf,
	withoutSessionCookie,
} from "../src/apps-host/policy.js";
import { createAppsHost } from "../src/apps-host/server.js";

const CAP = "0123456789abcdef0123456789abcdef";
const SLOT = 20005;
const TICKET_KEY = "tk";
const SIGNING_KEY = "sk";
const COCKPIT = "https://cockpit.example";

describe("apps host policy", () => {
	it("takes the slot from Fly-Forwarded-Port on Fly, never X-Forwarded-Port", () => {
		expect(
			slotOf(
				{ "fly-forwarded-port": "20003", "x-forwarded-port": "20009" },
				true,
			),
		).toBe(20003);
		expect(slotOf({ "x-forwarded-port": "20009" }, true)).toBeNull();
		expect(slotOf({ "fly-forwarded-port": "443" }, true)).toBeNull();
		expect(slotOf({ host: "127.0.0.1:20004" }, false)).toBe(20004);
	});

	it("sec.served-apart: refuses requests from another app's port (same-site) or with no fetch metadata", () => {
		expect(fetchSiteAllowed({ "sec-fetch-site": "same-origin" })).toBe(true);
		expect(fetchSiteAllowed({ "sec-fetch-site": "none" })).toBe(true);
		expect(fetchSiteAllowed({ "sec-fetch-site": "same-site" })).toBe(false);
		expect(fetchSiteAllowed({ "sec-fetch-site": "cross-site" })).toBe(false);
		expect(fetchSiteAllowed({})).toBe(false);
	});

	it("finds every session cookie, and strips them all before the app", () => {
		expect(sessionCookies("a=1; magi_app=x.y; magi_app=decoy")).toEqual([
			"x.y",
			"decoy",
		]);
		expect(withoutSessionCookie("a=1; magi_app=x.y; b=2")).toBe("a=1; b=2");
		expect(withoutSessionCookie("magi_app=x.y")).toBeUndefined();
	});

	it("scopes an app's cookies to its path, drops Domain and any cookie named like the session", () => {
		expect(
			rewriteSetCookies(
				[
					"k=v; Path=/; Domain=fly.dev; HttpOnly",
					"magi_app=forged; Path=/a/other/",
				],
				CAP,
			),
		).toEqual([`k=v; HttpOnly; Path=/a/${CAP}/`]);
	});
});

/** A stand-in monitor server: records what the apps host forwarded. */
function fakeMonitor() {
	const seen: Array<{ url?: string; headers: IncomingHttpHeaders }> = [];
	let reply: {
		status: number;
		type: string;
		headers?: Record<string, string>;
	} = { status: 200, type: "text/html" };
	const server = createServer((req, res) => {
		seen.push({ url: req.url, headers: req.headers });
		res.writeHead(reply.status, {
			"content-type": reply.type,
			...reply.headers,
		});
		res.end("app says hi");
	});
	server.on("upgrade", (req, socket) => {
		seen.push({ url: req.url, headers: req.headers });
		socket.end(
			"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
		);
	});
	return {
		server,
		seen,
		setReply: (r: typeof reply) => {
			reply = r;
		},
	};
}

describe("apps host", () => {
	let monitor: ReturnType<typeof fakeMonitor>;
	let host: Server;
	let port: number;
	const grant = (): AppGrant => ({
		userId: "u1",
		missionId: "m1",
		app: "dash",
		capability: CAP,
		slot: SLOT,
		machine: "127.0.0.1",
	});

	beforeEach(async () => {
		monitor = fakeMonitor();
		await new Promise<void>((r) =>
			monitor.server.listen(0, "127.0.0.1", () => r()),
		);
		const apps = createAppsHost({
			ticketKey: TICKET_KEY,
			signingKey: SIGNING_KEY,
			cockpitUrl: COCKPIT,
			onFly: false,
			monitorPort: (monitor.server.address() as AddressInfo).port,
		});
		host = createServer(apps.app);
		apps.attach(host);
		await new Promise<void>((r) => host.listen(0, "127.0.0.1", () => r()));
		port = (host.address() as AddressInfo).port;
	});
	afterEach(() => {
		monitor.server.close();
		host.close();
	});

	/** A request as the browser would send it on slot SLOT (the Host header carries the slot locally). */
	const send = (path: string, headers: Record<string, string> = {}) =>
		new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
			(resolve, reject) => {
				const r = request(
					{
						host: "127.0.0.1",
						port,
						path,
						headers: { host: `127.0.0.1:${SLOT}`, ...headers },
					},
					(res) => {
						let body = "";
						res.on("data", (d) => {
							body += d;
						});
						res.on("end", () =>
							resolve({
								status: res.statusCode ?? 0,
								headers: res.headers,
								body,
							}),
						);
					},
				);
				r.on("error", reject);
				r.end();
			},
		);
	const session = () => `magi_app=${signAppSession(grant(), TICKET_KEY)}`;

	it("redeems a ticket once, on its own slot, into a session for that app's path", async () => {
		const t = signAppTicket(grant(), TICKET_KEY);
		const r = await send(`/t/${t}`, {
			"sec-fetch-site": "cross-site",
			"sec-fetch-mode": "navigate",
		});
		expect(r.status).toBe(200);
		expect(r.headers["set-cookie"]?.[0]).toMatch(
			new RegExp(
				`^magi_app=.+; Path=/a/${CAP}/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict$`,
			),
		);
		expect(r.headers["clear-site-data"]).toBe('"storage"');
		expect(r.body).toContain(`url=/a/${CAP}/`);
		expect((await send(`/t/${t}`)).status).toBe(403);
		const other = signAppTicket({ ...grant(), slot: SLOT + 1 }, TICKET_KEY);
		expect((await send(`/t/${other}`)).status).toBe(403);
	});

	it("forwards an admitted request with the apps token, without the session cookie, and adds its headers", async () => {
		monitor.setReply({
			status: 200,
			type: "text/html",
			headers: { "set-cookie": "k=v; Path=/", "service-worker-allowed": "/" },
		});
		const r = await send(`/a/${CAP}/lab?x=1`, {
			"sec-fetch-site": "same-origin",
			cookie: `${session()}; theirs=1`,
		});
		expect(r.status).toBe(200);
		expect(r.body).toBe("app says hi");
		const got = monitor.seen[0];
		expect(got.url).toBe(`/a/${CAP}/lab?x=1`);
		expect(got.headers["x-apps-token"]).toBe(
			deriveAppsToken(SIGNING_KEY, "m1"),
		);
		expect(got.headers["x-apps-mission"]).toBe("m1");
		expect(got.headers.cookie).toBe("theirs=1");
		expect(r.headers["set-cookie"]).toEqual([`k=v; Path=/a/${CAP}/`]);
		expect(r.headers["service-worker-allowed"]).toBeUndefined();
		expect(r.headers["referrer-policy"]).toBe("no-referrer");
		expect(r.headers["content-security-policy"]).toContain(
			"frame-ancestors 'none'",
		);
	});

	it("refuses a request from another app's port, and one without a session, sending a page load to the cockpit", async () => {
		expect(
			(
				await send(`/a/${CAP}/`, {
					"sec-fetch-site": "same-site",
					cookie: session(),
				})
			).status,
		).toBe(403);
		const nav = await send(`/a/${CAP}/`, {
			"sec-fetch-site": "none",
			"sec-fetch-mode": "navigate",
		});
		expect(nav.status).toBe(302);
		expect(nav.headers.location).toBe(`${COCKPIT}/?openApp=${CAP}`);
		expect(monitor.seen).toEqual([]);
	});

	it("sec.served-apart: refuses a session issued for another slot (another app's origin)", async () => {
		const elsewhere = `magi_app=${signAppSession({ ...grant(), slot: SLOT + 1 }, TICKET_KEY)}`;
		expect(
			(
				await send(`/a/${CAP}/`, {
					"sec-fetch-site": "same-origin",
					cookie: elsewhere,
				})
			).status,
		).toBe(403);
	});

	it("turns the hop's refusal of a page load into a trip back to the cockpit", async () => {
		monitor.setReply({ status: 404, type: "text/plain" });
		const r = await send(`/a/${CAP}/`, {
			"sec-fetch-site": "none",
			"sec-fetch-mode": "navigate",
			cookie: session(),
		});
		expect(r.status).toBe(302);
		expect(r.headers.location).toBe(`${COCKPIT}/?openApp=${CAP}`);
	});

	it("carries a WebSocket only from the slot's own origin, with a session", async () => {
		const upgrade = (origin: string) =>
			new Promise<string>((resolve) => {
				const s = connect(port, "127.0.0.1", () =>
					s.write(
						`GET /a/${CAP}/api/kernels HTTP/1.1\r\nHost: 127.0.0.1:${SLOT}\r\nOrigin: ${origin}\r\nCookie: ${session()}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
					),
				);
				let got = "";
				s.on("data", (d) => {
					got += d;
				});
				s.on("close", () => resolve(got));
			});
		expect(await upgrade(`http://127.0.0.1:${SLOT + 1}`)).toMatch(
			/^HTTP\/1.1 403/,
		);
		expect(await upgrade(`http://127.0.0.1:${SLOT}`)).toMatch(/^HTTP\/1.1 101/);
		expect(monitor.seen.at(-1)?.headers["x-apps-mission"]).toBe("m1");
	});
});
