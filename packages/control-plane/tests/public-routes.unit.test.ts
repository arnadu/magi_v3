import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountPublicSurface } from "../src/public-routes.js";

describe("mountPublicSurface", () => {
	let server: Server;
	let base: string;

	beforeAll(async () => {
		const app = express();
		mountPublicSurface(app);
		server = app.listen(0);
		await new Promise<void>((r) => server.once("listening", () => r()));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await new Promise<void>((r) => server.close(() => r()));
	});

	it("answers /healthz without auth, uncached, with the security headers", async () => {
		const res = await fetch(`${base}/healthz`);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		const body = (await res.json()) as { ok: boolean; uptimeSeconds: number };
		expect(body.ok).toBe(true);
		expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
	});

	it("exposes nothing else about the process on /healthz", async () => {
		const body = await (await fetch(`${base}/healthz`)).json();
		expect(Object.keys(body as object).sort()).toEqual(["ok", "uptimeSeconds"]);
	});
});
