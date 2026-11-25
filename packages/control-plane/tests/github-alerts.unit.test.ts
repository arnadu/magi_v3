/**
 * security.read-alerts: only an agent the platform admin named, on a mission a platform admin
 * owns, reads the alerts; everyone else gets a 404 and GitHub is never called. No network.
 */
import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import { nextPage, readSecurityAlerts } from "../src/github-alerts.js";

const ENV = {
	PLATFORM_ADMIN_USER_IDS: "admin-uid",
	GITHUB_ALERTS_TOKEN: "alerts-token",
	GH_TOKEN: "issues-token",
};
const ADMIN_MISSION = {
	missionId: "magi-dev-1",
	userId: "admin-uid",
	securityAlerts: { agents: ["appsec"] },
};

function db(mission: Record<string, unknown> | null): Db {
	return {
		collection: () => ({ findOne: async () => mission }),
	} as unknown as Db;
}

const CS = {
	number: 7,
	created_at: "2026-11-20T00:00:00Z",
	rule: { id: "magi-path-from-request", security_severity_level: "high" },
	tool: { name: "Semgrep" },
	most_recent_instance: {
		location: { path: "packages/x.ts", start_line: 88 },
		message: { text: "x".repeat(2000) },
	},
	secret_extra_field: "dropped",
};
const DEP = {
	number: 3,
	created_at: "2026-11-21T00:00:00Z",
	dependency: {
		package: { name: "vite", ecosystem: "npm" },
		manifest_path: "package-lock.json",
	},
	security_advisory: {
		ghsa_id: "GHSA-aaaa",
		cve_id: "CVE-2026-1",
		severity: "medium",
		summary: "s",
	},
	security_vulnerability: {
		vulnerable_version_range: "< 6.4.6",
		first_patched_version: { identifier: "6.4.6" },
	},
};

function fakeFetch(answers: Record<string, { status: number; body: unknown }>) {
	const calls: { url: string; auth: string }[] = [];
	const f = (async (url: string, init?: RequestInit) => {
		const auth = (init?.headers as Record<string, string>).Authorization;
		calls.push({ url, auth });
		const kind = url.includes("/code-scanning/") ? "cs" : "dep";
		const a = answers[kind];
		// Like GitHub: a full page links to the next by cursor; `page=` is refused by Dependabot.
		if (/[?&]page=/.test(url)) return new Response("{}", { status: 400 });
		const full = Array.isArray(a.body) && a.body.length === 100;
		const headers: Record<string, string> = full
			? {
					link: `<https://api.github.com${new URL(url).pathname}?state=open&per_page=100&after=c${calls.length}>; rel="next"`,
				}
			: {};
		return new Response(JSON.stringify(a.body), { status: a.status, headers });
	}) as unknown as typeof fetch;
	return { f, calls };
}

describe("readSecurityAlerts", () => {
	it("returns both kinds, trimmed, read with the alerts token", async () => {
		const { f, calls } = fakeFetch({
			cs: { status: 200, body: [CS] },
			dep: { status: 200, body: [DEP] },
		});
		const r = await readSecurityAlerts(
			db(ADMIN_MISSION),
			"magi-dev-1",
			"appsec",
			{ fetch: f, env: ENV },
		);
		expect(r.status).toBe(200);
		if (r.status !== 200) throw new Error();
		expect(r.alerts).toHaveLength(2);
		const [cs, dep] = r.alerts;
		expect(cs).toMatchObject({
			source: "code-scanning",
			number: 7,
			rule: "magi-path-from-request",
			severity: "high",
			path: "packages/x.ts",
			line: 88,
		});
		expect(cs.source === "code-scanning" && cs.message.length).toBe(500);
		expect(JSON.stringify(cs)).not.toContain("secret_extra_field");
		expect(dep).toMatchObject({
			source: "dependabot",
			package: "vite",
			advisory: "GHSA-aaaa",
			patched: "6.4.6",
		});
		expect(calls.every((c) => c.auth === "Bearer alerts-token")).toBe(true);
		expect(calls[0].url).toContain("state=open");
	});

	it.each([
		[
			"the owner is not a platform admin",
			{ ...ADMIN_MISSION, userId: "tenant-uid" },
			"appsec",
		],
		["the agent is not named", ADMIN_MISSION, "documenter"],
		[
			"the mission names no agent",
			{ ...ADMIN_MISSION, securityAlerts: undefined },
			"appsec",
		],
		[
			"the stored field is invalid",
			{ ...ADMIN_MISSION, securityAlerts: { agents: "appsec" } },
			"appsec",
		],
		["no agent is given", ADMIN_MISSION, undefined],
		["the mission does not exist", null, "appsec"],
	])("answers 404 and never calls GitHub when %s", async (_why, mission, agent) => {
		const { f, calls } = fakeFetch({
			cs: { status: 200, body: [CS] },
			dep: { status: 200, body: [] },
		});
		const r = await readSecurityAlerts(db(mission), "magi-dev-1", agent, {
			fetch: f,
			env: ENV,
		});
		expect(r).toEqual({ status: 404, error: "Not found" });
		expect(calls).toHaveLength(0);
	});

	it("answers 503 without a token, after the access check", async () => {
		const r = await readSecurityAlerts(
			db(ADMIN_MISSION),
			"magi-dev-1",
			"appsec",
			{
				env: { ...ENV, GITHUB_ALERTS_TOKEN: "" },
			},
		);
		expect(r.status).toBe(503);
	});

	it("treats no analysis yet (404) as no alerts, and a GitHub failure as 502", async () => {
		const none = fakeFetch({
			cs: { status: 404, body: {} },
			dep: { status: 200, body: [] },
		});
		const r = await readSecurityAlerts(
			db(ADMIN_MISSION),
			"magi-dev-1",
			"appsec",
			{ fetch: none.f, env: ENV },
		);
		expect(r).toEqual({ status: 200, alerts: [] });
		const down = fakeFetch({
			cs: { status: 500, body: {} },
			dep: { status: 200, body: [] },
		});
		const r2 = await readSecurityAlerts(
			db(ADMIN_MISSION),
			"magi-dev-1",
			"appsec",
			{ fetch: down.f, env: ENV },
		);
		expect(r2.status).toBe(502);
	});

	it("follows only a next link that stays on the API host", () => {
		expect(
			nextPage(
				'<https://api.github.com/repos/a/b/x?after=Y>; rel="next", <https://api.github.com/z>; rel="last"',
			),
		).toBe("https://api.github.com/repos/a/b/x?after=Y");
		expect(nextPage('<https://evil.example/x>; rel="next"')).toBeNull();
		expect(nextPage(null)).toBeNull();
	});

	it("reads further pages through the Link header, at most three", async () => {
		const full = Array.from({ length: 100 }, (_, i) => ({ ...CS, number: i }));
		const { f, calls } = fakeFetch({
			cs: { status: 200, body: full },
			dep: { status: 200, body: [] },
		});
		const r = await readSecurityAlerts(
			db(ADMIN_MISSION),
			"magi-dev-1",
			"appsec",
			{ fetch: f, env: ENV },
		);
		expect(calls.filter((c) => c.url.includes("/code-scanning/"))).toHaveLength(
			3,
		);
		expect(r.status === 200 && r.alerts.length).toBe(300);
	});
});
