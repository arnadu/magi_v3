/**
 * github-issues.ts — GitHub writes as a confirmed action (F-021/F-023/EXFIL1,
 * MCR3). GitHub is injected; Mongo is a minimal fake.
 */

import { describe, expect, it, vi } from "vitest";
import {
	executeGithubIssueAction,
	GITHUB_ISSUE_ACTION,
	GithubIssueQuota,
	githubIssueLabel,
	githubIssuePendingAction,
	parseGithubIssuePayload,
	proposeIssueForMissionOwner,
	provenanceBlock,
	searchOpenIssues,
} from "../src/github-issues.js";
import { MemoryPendingActionsStore } from "./helpers/pending-actions.js";

function fakeGh(responses: Array<{ status: number; body: unknown }>) {
	const calls: Array<{ path: string; init?: RequestInit }> = [];
	const fn = vi.fn(async (path: string, init?: RequestInit) => {
		calls.push({ path, init });
		const r = responses.shift() ?? { status: 200, body: {} };
		return new Response(JSON.stringify(r.body), { status: r.status });
	});
	return { fn, calls };
}

describe("parseGithubIssuePayload", () => {
	it("accepts the three operations and normalises them", () => {
		expect(
			parseGithubIssuePayload({
				op: "create",
				title: "T",
				body: "B",
				labels: ["bug"],
				missionId: "m1",
			}),
		).toEqual({
			op: "create",
			title: "T",
			body: "B",
			labels: ["bug"],
			missionId: "m1",
		});
		expect(
			parseGithubIssuePayload({ op: "comment", number: 7, body: "x" }),
		).toEqual({
			op: "comment",
			number: 7,
			body: "x",
			missionId: undefined,
		});
		expect(parseGithubIssuePayload({ op: "close", number: 7 })).toEqual({
			op: "close",
			number: 7,
			comment: undefined,
			missionId: undefined,
		});
	});

	it("rejects unknown ops, missing text, bad numbers, oversize bodies and odd labels", () => {
		expect(() => parseGithubIssuePayload({ op: "delete" })).toThrow(
			/op must be/,
		);
		expect(() =>
			parseGithubIssuePayload({ op: "create", title: "", body: "b" }),
		).toThrow(/title is required/);
		expect(() =>
			parseGithubIssuePayload({ op: "comment", number: "7", body: "b" }),
		).toThrow(/positive integer/);
		expect(() =>
			parseGithubIssuePayload({
				op: "create",
				title: "t",
				body: "x".repeat(20_001),
			}),
		).toThrow(/exceeds/);
		expect(() =>
			parseGithubIssuePayload({
				op: "create",
				title: "t",
				body: "b",
				labels: ["<script>"],
			}),
		).toThrow(/invalid label/);
		expect(() => parseGithubIssuePayload("create")).toThrow(
			/must be an object/,
		);
	});
});

describe("labels and provenance", () => {
	it("computes the card label server-side from the payload", () => {
		expect(
			githubIssueLabel({ op: "create", title: "Fix X", body: "", labels: [] }),
		).toMatch(/^Create GitHub issue .*“Fix X”$/);
		expect(githubIssueLabel({ op: "comment", number: 3, body: "" })).toMatch(
			/Comment on GitHub issue #3/,
		);
		expect(
			githubIssueLabel({ op: "close", number: 3, comment: "done" }),
		).toMatch(/Close GitHub issue #3 .*with a comment/);
	});

	it("names the origin and says the text is machine-written", () => {
		expect(provenanceBlock("user-123456789")).toMatch(
			/control-plane copilot .*user-123.*LLM/s,
		);
		expect(provenanceBlock("u", "m1")).toMatch(
			/mission copilot of mission `m1`/,
		);
	});
});

describe("GithubIssueQuota", () => {
	it("caps per user per UTC day", () => {
		let now = new Date("2026-10-17T10:00:00Z");
		const q = new GithubIssueQuota(2, () => now);
		expect(q.take("a")).toBe(true);
		expect(q.take("a")).toBe(true);
		expect(q.take("a")).toBe(false);
		expect(q.take("b")).toBe(true);
		now = new Date("2026-10-18T00:00:01Z");
		expect(q.take("a")).toBe(true);
	});
});

describe("executeGithubIssueAction", () => {
	it("creates an issue with the provenance prefix and, from a mission, the forced label", async () => {
		const gh = fakeGh([
			{ status: 201, body: { number: 9, html_url: "https://x/9" } },
		]);
		const out = await executeGithubIssueAction(
			{ op: "create", title: "T", body: "B", labels: ["bug"], missionId: "m1" },
			{ userId: "owner-1" },
			{ fetchFn: gh.fn as never, quota: new GithubIssueQuota(5) },
		);
		expect(out).toBe("Created #9: https://x/9");
		const sent = JSON.parse(String(gh.calls[0].init?.body)) as {
			body: string;
			labels: string[];
		};
		expect(
			sent.body.startsWith("> Filed by the mission copilot of mission `m1`"),
		).toBe(true);
		expect(sent.body.endsWith("B")).toBe(true);
		expect(sent.labels).toEqual(["mission-copilot", "bug"]);
	});

	it("comments and closes (comment first), and refuses past the daily cap", async () => {
		const gh = fakeGh([
			{ status: 201, body: { html_url: "https://x/c" } },
			{ status: 201, body: { html_url: "https://x/c2" } },
			{ status: 200, body: {} },
		]);
		const quota = new GithubIssueQuota(2);
		expect(
			await executeGithubIssueAction(
				{ op: "comment", number: 4, body: "hi" },
				{ userId: "u" },
				{ fetchFn: gh.fn as never, quota },
			),
		).toBe("Comment added: https://x/c");
		expect(
			await executeGithubIssueAction(
				{ op: "close", number: 4, comment: "bye" },
				{ userId: "u" },
				{ fetchFn: gh.fn as never, quota },
			),
		).toBe("Closed #4");
		expect(gh.calls.map((c) => `${c.init?.method} ${c.path}`)).toEqual([
			"POST /repos/arnadu/magi_v3/issues/4/comments",
			"POST /repos/arnadu/magi_v3/issues/4/comments",
			"PATCH /repos/arnadu/magi_v3/issues/4",
		]);
		await expect(
			executeGithubIssueAction(
				{ op: "comment", number: 4, body: "again" },
				{ userId: "u" },
				{ fetchFn: gh.fn as never, quota },
			),
		).rejects.toThrow(/daily cap/);
	});

	it("does not echo the upstream body on failure", async () => {
		const gh = fakeGh([
			{ status: 422, body: { message: "secret-ish details" } },
		]);
		await expect(
			executeGithubIssueAction(
				{ op: "create", title: "T", body: "B", labels: [] },
				{ userId: "u" },
				{ fetchFn: gh.fn as never, quota: new GithubIssueQuota(5) },
			),
		).rejects.toThrow(/^GitHub API returned 422$/);
	});
});

describe("proposeIssueForMissionOwner", () => {
	it("creates a pending action for the mission's owner and notifies their cockpit; nothing is filed", async () => {
		const pending = new MemoryPendingActionsStore();
		const notified: Array<{ userId: string; type: string; data: unknown }> = [];
		const db = {
			collection: () => ({
				findOne: async ({ missionId }: { missionId: string }) =>
					missionId === "m1" ? { missionId: "m1", userId: "owner-1" } : null,
			}),
		} as never;
		const r = await proposeIssueForMissionOwner(
			{
				db,
				pending,
				notify: (userId, type, data) => notified.push({ userId, type, data }),
			},
			"m1",
			{ title: "Daemon crash", body: "trace", labels: ["bug"] },
		);
		expect(r.ownerUserId).toBe("owner-1");
		const action = await pending.get(r.pendingActionId);
		expect(action).toMatchObject({
			userId: "owner-1",
			type: GITHUB_ISSUE_ACTION,
			payload: { op: "create", title: "Daemon crash", missionId: "m1" },
		});
		expect(notified).toEqual([
			{
				userId: "owner-1",
				type: "copilot-action",
				data: expect.objectContaining({
					id: r.pendingActionId,
					payload: expect.any(Object),
				}),
			},
		]);
		expect(r.message).toMatch(/Nothing has been filed yet/);
		await expect(
			proposeIssueForMissionOwner({ db, pending, notify: () => {} }, "nope", {
				title: "t",
				body: "b",
			}),
		).rejects.toThrow(/not found/);
	});
});

describe("searchOpenIssues", () => {
	it("uses the search endpoint when a query is given and the list endpoint otherwise (MCR3)", async () => {
		const gh = fakeGh([
			{
				status: 200,
				body: {
					items: [
						{
							number: 1,
							title: "A",
							labels: [{ name: "bug" }],
							body: null,
							html_url: "h",
						},
					],
				},
			},
			{
				status: 200,
				body: [
					{ number: 2, title: "B", labels: [], body: "x", html_url: "h2" },
				],
			},
		]);
		const a = await searchOpenIssues(
			{ q: "crash loop", label: "bug" },
			gh.fn as never,
		);
		expect(a).toEqual([
			{ number: 1, title: "A", labels: ["bug"], body: "", html_url: "h" },
		]);
		expect(decodeURIComponent(gh.calls[0].path)).toContain(
			'q=repo:arnadu/magi_v3 is:issue is:open label:"bug" crash loop',
		);
		const b = await searchOpenIssues({}, gh.fn as never);
		expect(b[0].number).toBe(2);
		expect(gh.calls[1].path).toMatch(
			/^\/repos\/arnadu\/magi_v3\/issues\?state=open/,
		);
	});
});

describe("githubIssuePendingAction", () => {
	it("is typed file_github_issue with a server-computed label", () => {
		const a = githubIssuePendingAction("u", { op: "close", number: 2 });
		expect(a.type).toBe(GITHUB_ISSUE_ACTION);
		expect(a.label).toMatch(/Close GitHub issue #2/);
	});
});
