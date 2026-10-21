import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

// Each proxy instance answers with the path its own pathRewrite produces, so
// the test sees which mission's rewrite served a request.
vi.mock("http-proxy-middleware", () => ({
	createProxyMiddleware: vi.fn(
		(opts: { pathRewrite: (p: string) => string }) =>
			(req: express.Request, res: express.Response) =>
				res.json({ upstreamPath: opts.pathRewrite(req.originalUrl) }),
	),
}));

import { createProxyMiddleware } from "http-proxy-middleware";
import { createProxyRouter } from "../src/proxy.js";
import { fakeDb } from "./support/fake-db.js";

let server: Server | undefined;
afterEach(
	() =>
		new Promise<void>((r) => {
			if (!server) return r();
			server.close(() => r());
			server = undefined;
		}),
);

describe("mission proxy", () => {
	it("keeps each mission's path rewrite when two missions share a private address (PX1)", async () => {
		const { db } = fakeDb({
			missions: [
				{
					missionId: "m1",
					userId: "u1",
					status: "running",
					privateIp: "fdaa::1",
				},
				{
					missionId: "m2",
					userId: "u1",
					status: "running",
					privateIp: "fdaa::1",
				},
			],
		});
		const app = express();
		app.use((req, _res, next) => {
			req.userId = "u1";
			req.isAdmin = false;
			next();
		});
		app.use(createProxyRouter(db));
		await new Promise<void>((r) => {
			server = app.listen(0, "127.0.0.1", r);
		});
		const base = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;

		const a = await (await fetch(`${base}/missions/m1/status`)).json();
		const b = await (await fetch(`${base}/missions/m2/status`)).json();
		expect(a.upstreamPath).toBe("/status");
		expect(b.upstreamPath).toBe("/status");
		expect(vi.mocked(createProxyMiddleware)).toHaveBeenCalledTimes(2);
		// A second request for a mission reuses its instance.
		await fetch(`${base}/missions/m1/status`);
		expect(vi.mocked(createProxyMiddleware)).toHaveBeenCalledTimes(2);
	});
});
