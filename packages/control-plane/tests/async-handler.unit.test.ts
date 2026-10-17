/**
 * C1: a rejected async route handler must reach the error middleware as a
 * JSON 500, never hang the request or escape as an unhandled rejection.
 */

import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { asyncHandler } from "../src/async-handler.js";
import {
	errorMiddleware,
	installProcessGuards,
} from "../src/process-guards.js";

describe("asyncHandler + errorMiddleware", () => {
	const log = { error: vi.fn() };
	let base: string;
	let server: ReturnType<express.Express["listen"]>;

	beforeAll(async () => {
		const app = express();
		app.get(
			"/boom",
			asyncHandler(async () => {
				throw new Error("secret internal detail /srv/x");
			}),
		);
		app.get(
			"/ok",
			asyncHandler(async (_req, res) => {
				res.json({ ok: true });
			}),
		);
		app.get(
			"/late",
			asyncHandler(async (_req, res) => {
				res.write("partial");
				throw new Error("after headers");
			}),
		);
		app.use(errorMiddleware(log));
		await new Promise<void>((r) => {
			server = app.listen(0, "127.0.0.1", r);
		});
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => new Promise<void>((r) => server.close(() => r())));

	it("turns a rejection into a JSON 500 without echoing the message", async () => {
		const res = await fetch(`${base}/boom`);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "Internal server error" });
		expect(log.error).toHaveBeenCalledTimes(1);
		expect(log.error.mock.calls[0][0]).toContain("secret internal detail");
		expect(log.error.mock.calls[0][0]).toContain('path: "/boom"');
	});

	it("passes a successful handler through untouched", async () => {
		const res = await fetch(`${base}/ok`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("ends a response whose headers were already sent instead of hanging", async () => {
		const res = await fetch(`${base}/late`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("partial");
	});
});

describe("installProcessGuards", () => {
	it("logs an unhandled rejection with its message and keeps the process alive", async () => {
		const log = { error: vi.fn() };
		const before = process.listeners("unhandledRejection");
		installProcessGuards(log);
		const handler = process
			.listeners("unhandledRejection")
			.find((l) => !before.includes(l)) as (reason: unknown) => void;
		expect(handler).toBeDefined();
		handler(new Error("nobody awaited me"));
		expect(log.error.mock.calls[0][0]).toContain("nobody awaited me");
		expect(log.error.mock.calls[0][0]).toContain("the process continues");
		process.removeListener("unhandledRejection", handler);
		const exc = process
			.listeners("uncaughtException")
			.find((l) => l.toString().includes("Fly restarts"));
		if (exc) process.removeListener("uncaughtException", exc);
	});
});
