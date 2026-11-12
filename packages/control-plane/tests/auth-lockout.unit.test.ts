/**
 * The failed-authentication limiter guards the guessable admin key without
 * locking out a browser whose Firebase session has expired: one page load
 * sends many requests at once, and each used to count as a failed guess.
 */
import type { NextFunction, Request, Response } from "express";
import type { Db } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/firebase.js", () => ({
	verifyFirebaseToken: vi.fn(async (token: string) => {
		if (token === "valid-firebase") return { uid: "u1", email: "u1@x" };
		if (token === "expired-firebase") {
			throw Object.assign(new Error("Firebase ID token has expired"), {
				code: "auth/id-token-expired",
			});
		}
		throw Object.assign(new Error("Decoding Firebase ID token failed"), {
			code: "auth/argument-error",
		});
	}),
}));
vi.mock("../src/users.js", () => ({ syncFirebaseUser: vi.fn(async () => {}) }));

const { createAuthMiddleware, isExpiredTokenError } = await import(
	"../src/auth.js"
);
const { FailedAuthLimiter } = await import("../src/auth-limiter.js");

function call(
	mw: ReturnType<typeof createAuthMiddleware>,
	credential: string,
): Promise<{ status: number; passed: boolean }> {
	return new Promise((resolve) => {
		const req = {
			headers: { authorization: `Bearer ${credential}` },
			ip: "203.0.113.7",
			method: "GET",
			path: "/api/missions",
		} as unknown as Request;
		let status = 0;
		const res = {
			setHeader: () => res,
			status(s: number) {
				status = s;
				return res;
			},
			json: () => resolve({ status, passed: false }),
		} as unknown as Response;
		const next: NextFunction = () => resolve({ status: 200, passed: true });
		void mw(req, res, next);
	});
}

describe("authentication lockout", () => {
	const ORIGINAL = process.env.CONTROL_API_KEY;
	beforeEach(() => {
		process.env.CONTROL_API_KEY = "the-admin-key";
	});
	afterEach(() => {
		process.env.CONTROL_API_KEY = ORIGINAL;
	});

	it("an expired Firebase session, however many requests carry it, never blocks the sign-in", async () => {
		const mw = createAuthMiddleware(
			{} as Db,
			new FailedAuthLimiter({ maxFailures: 5 }),
		);
		for (let i = 0; i < 25; i++) {
			expect((await call(mw, "expired-firebase")).status).toBe(401);
		}
		expect(await call(mw, "valid-firebase")).toEqual({
			status: 200,
			passed: true,
		});
	});

	it("admin-key guesses get the client blocked, and a blocked client can't use the admin key", async () => {
		const mw = createAuthMiddleware(
			{} as Db,
			new FailedAuthLimiter({ maxFailures: 5 }),
		);
		for (let i = 0; i < 5; i++) await call(mw, `guess-${i}`);
		expect((await call(mw, "guess-6")).status).toBe(429);
		expect((await call(mw, "the-admin-key")).status).toBe(429);
	});

	it("a blocked browser can still sign in with a valid Firebase token", async () => {
		const mw = createAuthMiddleware(
			{} as Db,
			new FailedAuthLimiter({ maxFailures: 5 }),
		);
		for (let i = 0; i < 5; i++) await call(mw, `guess-${i}`);
		expect((await call(mw, "valid-firebase")).passed).toBe(true);
	});

	it("recognises Firebase's expiry error by code or message", () => {
		expect(isExpiredTokenError({ code: "auth/id-token-expired" })).toBe(true);
		expect(
			isExpiredTokenError(new Error("... (auth/id-token-expired). See ...")),
		).toBe(true);
		expect(isExpiredTokenError({ code: "auth/argument-error" })).toBe(false);
	});
});
