/**
 * The test-only sign-in (environment B): refused on Fly, strict about its format, and a test
 * user is an ordinary tenant.
 */
import type { NextFunction, Request, Response } from "express";
import type { Db } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthMiddleware } from "../src/auth.js";
import { matchTestUser, testUsersFromEnv } from "../src/auth-test-users.js";

const TOKEN_A = "a".repeat(40);
const TOKEN_B = "b".repeat(40);

afterEach(() => vi.unstubAllEnvs());

describe("testUsersFromEnv", () => {
	it("is off when the variable is unset or empty", () => {
		expect(testUsersFromEnv({})).toBeNull();
		expect(testUsersFromEnv({ AUTH_TEST_USERS: " " })).toBeNull();
	});

	it("reads token=test-user pairs", () => {
		const users = testUsersFromEnv({
			AUTH_TEST_USERS: `${TOKEN_A}=test-alice, ${TOKEN_B}=test-bob`,
		});
		expect(users && [...users.values()]).toEqual(["test-alice", "test-bob"]);
	});

	it("is refused on Fly", () => {
		expect(() =>
			testUsersFromEnv({
				AUTH_TEST_USERS: `${TOKEN_A}=test-alice`,
				FLY_APP_NAME: "magi-control-dev",
			}),
		).toThrow(/refused/);
	});

	it.each([
		["a short token", "short=test-alice"],
		["a user id that is not a test user", `${TOKEN_A}=alice`],
		["a user id that could be an admin", `${TOKEN_A}=admin`],
		["no separator", TOKEN_A],
		["an empty token", "=test-alice"],
	])("refuses %s", (_what, value) => {
		expect(() => testUsersFromEnv({ AUTH_TEST_USERS: value })).toThrow();
	});

	it("matches only an exact token", () => {
		const users = testUsersFromEnv({
			AUTH_TEST_USERS: `${TOKEN_A}=test-alice`,
		});
		if (!users) throw new Error("expected users");
		expect(matchTestUser(users, TOKEN_A)).toBe("test-alice");
		expect(matchTestUser(users, `${TOKEN_A}x`)).toBeUndefined();
		expect(matchTestUser(users, TOKEN_A.slice(1))).toBeUndefined();
	});
});

describe("the auth middleware with test users", () => {
	const db = {} as Db;
	function call(token: string | undefined) {
		const mw = createAuthMiddleware(db);
		const req = {
			headers: token ? { authorization: `Bearer ${token}` } : {},
			ip: "127.0.0.1",
			method: "GET",
			path: "/api/missions",
		} as unknown as Request;
		const res = {
			statusCode: 200,
			status(c: number) {
				this.statusCode = c;
				return this;
			},
			json() {
				return this;
			},
			setHeader() {},
		} as unknown as Response & { statusCode: number };
		const next = vi.fn() as unknown as NextFunction;
		return { mw, req, res, next };
	}

	it("cannot be built on Fly with test users configured", () => {
		vi.stubEnv("AUTH_TEST_USERS", `${TOKEN_A}=test-alice`);
		vi.stubEnv("FLY_APP_NAME", "magi-control-dev");
		expect(() => createAuthMiddleware(db)).toThrow(/refused/);
	});

	it("signs a test token in as an ordinary tenant, never an admin", async () => {
		vi.stubEnv("AUTH_TEST_USERS", `${TOKEN_A}=test-alice`);
		vi.stubEnv("FLY_APP_NAME", "");
		vi.stubEnv("CONTROL_API_KEY", "k".repeat(40));
		const { mw, req, res, next } = call(TOKEN_A);
		await mw(req, res, next);
		expect(next).toHaveBeenCalled();
		expect(req.userId).toBe("test-alice");
		expect(req.isAdmin).toBe(false);
	});

	it("ignores test tokens when the variable is unset", async () => {
		vi.stubEnv("AUTH_TEST_USERS", "");
		vi.stubEnv("CONTROL_API_KEY", "k".repeat(40));
		const { mw, req, res, next } = call(TOKEN_A);
		await mw(req, res, next).catch(() => undefined);
		expect(req.userId).not.toBe("test-alice");
	});
});
