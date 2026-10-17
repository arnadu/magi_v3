import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	clearSessionCookieHeader,
	createSessionRouter,
	sessionCookieHeader,
} from "../src/session-routes.js";

describe("session cookie headers", () => {
	it("issues an HttpOnly, Secure, SameSite=Strict cookie with the token encoded", () => {
		const h = sessionCookieHeader("a b;c=d");
		expect(h.startsWith("magi_session=a%20b%3Bc%3Dd;")).toBe(true);
		expect(h).toContain("HttpOnly");
		expect(h).toContain("Secure");
		expect(h).toContain("SameSite=Strict");
		expect(h).toContain("Path=/");
		expect(h).toContain("Max-Age=3600");
	});

	it("clears with the same attributes and a zero lifetime", () => {
		const h = clearSessionCookieHeader();
		expect(h.startsWith("magi_session=;")).toBe(true);
		expect(h).toContain("Max-Age=0");
		expect(h).toContain("HttpOnly");
		expect(h).toContain("Secure");
	});
});

describe("session routes", () => {
	let base: string;
	let server: ReturnType<express.Express["listen"]>;

	beforeAll(async () => {
		const app = express();
		// Stand-in for requireAuth, which runs before this router in index.ts.
		app.use((req, _res, next) => {
			req.userId = "user-1";
			req.isAdmin = req.headers.authorization === "Bearer admin-key";
			next();
		});
		app.use("/api/auth", createSessionRouter());
		await new Promise<void>((r) => {
			server = app.listen(0, "127.0.0.1", r);
		});
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
	});
	afterAll(() => new Promise<void>((r) => server.close(() => r())));

	it("POST /session needs a bearer and answers with the cookie", async () => {
		const noBearer = await fetch(`${base}/session`, { method: "POST" });
		expect(noBearer.status).toBe(400);

		const res = await fetch(`${base}/session`, {
			method: "POST",
			headers: { Authorization: "Bearer admin-key" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			userId: "user-1",
			isAdmin: true,
		});
		const cookie = res.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("magi_session=admin-key;");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("SameSite=Strict");
	});

	it("GET /me reports the authenticated identity; POST /logout clears the cookie", async () => {
		const me = await fetch(`${base}/me`);
		expect(await me.json()).toEqual({ userId: "user-1", isAdmin: false });

		const out = await fetch(`${base}/logout`, { method: "POST" });
		expect(out.status).toBe(200);
		expect(out.headers.get("set-cookie")).toContain("magi_session=;");
		expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
	});
});
