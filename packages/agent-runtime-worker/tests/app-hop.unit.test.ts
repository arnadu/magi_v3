import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppHop, appsTokenFromEnv, createAppHop } from "../src/app-hop.js";

const CAP_J = "a".repeat(32);
const CAP_G = "b".repeat(32);

/** A stand-in app: answers with what it received; echoes the bytes of an upgraded connection. */
function fakeApp(): Promise<{
	server: Server;
	port: number;
	seen: Array<{ url?: string; headers: IncomingHttpHeaders }>;
}> {
	const seen: Array<{ url?: string; headers: IncomingHttpHeaders }> = [];
	const server = createServer((req, res) => {
		seen.push({ url: req.url, headers: req.headers });
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ url: req.url }));
	});
	server.on("upgrade", (req, socket) => {
		seen.push({ url: req.url, headers: req.headers });
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
		);
		socket.pipe(socket);
	});
	return new Promise((r) =>
		server.listen(0, "127.0.0.1", () =>
			r({ server, port: (server.address() as AddressInfo).port, seen }),
		),
	);
}

function hopServer(hop: AppHop): Promise<{ server: Server; port: number }> {
	const server = createServer((req, res) => {
		if (hop.owns(req.url ?? "")) hop.http(req, res);
		else res.writeHead(418).end();
	});
	server.on("upgrade", (req, socket, head) => hop.upgrade(req, socket, head));
	return new Promise((r) =>
		server.listen(0, "127.0.0.1", () =>
			r({ server, port: (server.address() as AddressInfo).port }),
		),
	);
}

describe("the hop from the monitor server to an app", () => {
	let app: Awaited<ReturnType<typeof fakeApp>>;
	let hop: Awaited<ReturnType<typeof hopServer>>;
	const touched: string[] = [];

	beforeEach(async () => {
		app = await fakeApp();
		hop = await hopServer(
			createAppHop({
				missionId: "m1",
				appsToken: "apps-secret",
				route: (cap) =>
					cap === CAP_J
						? {
								name: "nb",
								port: app.port,
								keepPrefix: true,
								jupyterToken: "jt",
							}
						: cap === CAP_G
							? { name: "dash", port: app.port, keepPrefix: false }
							: undefined,
				touch: (n) => touched.push(n),
			}),
		);
	});
	afterEach(() => {
		app.server.close();
		hop.server.close();
		touched.length = 0;
	});

	const get = (
		path: string,
		headers: Record<string, string> = {
			"x-apps-token": "apps-secret",
			"x-apps-mission": "m1",
		},
	) => fetch(`http://127.0.0.1:${hop.port}${path}`, { headers });

	it("refuses a request without the apps token, for another mission, or for no running app", async () => {
		expect((await get(`/a/${CAP_G}/`, { "x-apps-mission": "m1" })).status).toBe(
			401,
		);
		expect(
			(
				await get(`/a/${CAP_G}/`, {
					"x-apps-token": "nope",
					"x-apps-mission": "m1",
				})
			).status,
		).toBe(401);
		expect(
			(
				await get(`/a/${CAP_G}/`, {
					"x-apps-token": "apps-secret",
					"x-apps-mission": "m2",
				})
			).status,
		).toBe(404);
		expect((await get(`/a/${"c".repeat(32)}/`)).status).toBe(404);
		expect(app.seen).toEqual([]);
	});

	it("does not accept the monitor token in place of the apps token", async () => {
		expect(
			(
				await get(`/a/${CAP_G}/`, {
					"x-monitor-token": "apps-secret",
					"x-apps-mission": "m1",
				})
			).status,
		).toBe(401);
	});

	it("removes the prefix for a Gradio app, keeps it for JupyterLab, and adds Jupyter's token", async () => {
		expect(await (await get(`/a/${CAP_G}/config?x=1`)).json()).toEqual({
			url: "/config?x=1",
		});
		expect(await (await get(`/a/${CAP_J}/lab/tree`)).json()).toEqual({
			url: `/a/${CAP_J}/lab/tree`,
		});
		expect(app.seen[1].headers.authorization).toBe("token jt");
		expect(app.seen[0].headers.authorization).toBeUndefined();
		expect(touched).toEqual(["dash", "nb"]);
	});

	it("never forwards the hop headers to the app", async () => {
		await get(`/a/${CAP_G}/`);
		expect(app.seen[0].headers["x-apps-token"]).toBeUndefined();
		expect(app.seen[0].headers["x-apps-mission"]).toBeUndefined();
	});

	it("carries a WebSocket upgrade through, with the same checks", async () => {
		const tunnel = (headers: string) =>
			new Promise<string>((resolve) => {
				const s = connect(hop.port, "127.0.0.1", () => {
					s.write(
						`GET /a/${CAP_G}/queue/join HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${headers}\r\n`,
					);
				});
				let got = "";
				s.on("data", (d) => {
					got += d.toString();
					if (got.includes("101 Switching") && !got.includes("ping"))
						s.write("ping");
					if (got.includes("ping") || got.startsWith("HTTP/1.1 4")) {
						s.destroy();
						resolve(got);
					}
				});
				s.on("close", () => resolve(got));
			});
		const ok = await tunnel(
			"x-apps-token: apps-secret\r\nx-apps-mission: m1\r\n",
		);
		expect(ok).toContain("101 Switching Protocols");
		expect(ok).toContain("ping");
		expect(app.seen.at(-1)?.url).toBe("/queue/join");
		expect(app.seen.at(-1)?.headers["x-apps-token"]).toBeUndefined();
		expect(await tunnel("x-apps-mission: m1\r\n")).toMatch(/^HTTP\/1.1 401/);
	});
});

describe("appsTokenFromEnv", () => {
	it("refuses everything on Fly without a token, rather than stopping the daemon", () => {
		expect(appsTokenFromEnv({ FLY_APP_NAME: "magi-missions-dev" })).toBeNull();
		expect(appsTokenFromEnv({ FLY_APP_NAME: "x", APPS_TOKEN: "t" })).toBe("t");
		expect(appsTokenFromEnv({})).toBe("");
	});
});
