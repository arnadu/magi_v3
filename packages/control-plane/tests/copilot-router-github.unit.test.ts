/**
 * executeAction's file_github_issue branch: re-validates the payload and
 * delegates to github-issues.ts with the confirming operator's identity.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/github-issues.js", async () => {
	const actual = await vi.importActual<
		typeof import("../src/github-issues.js")
	>("../src/github-issues.js");
	return { ...actual, executeGithubIssueAction: vi.fn() };
});

import { executeAction } from "../src/copilot-router.js";
import { executeGithubIssueAction } from "../src/github-issues.js";

const db = { collection: () => ({}) } as never;

describe("executeAction: file_github_issue", () => {
	it("re-validates and executes as the action's user", async () => {
		vi.mocked(executeGithubIssueAction).mockResolvedValue("Created #1: u");
		const result = await executeAction(
			db,
			{
				id: "a1",
				userId: "owner-1",
				type: "file_github_issue",
				label: "x",
				payload: { op: "create", title: "T", body: "B", labels: ["bug"] },
				createdAt: new Date(),
			},
			"owner-1",
		);
		expect(result).toBe("Created #1: u");
		expect(executeGithubIssueAction).toHaveBeenCalledWith(
			{
				op: "create",
				title: "T",
				body: "B",
				labels: ["bug"],
				missionId: undefined,
			},
			{ userId: "owner-1" },
		);
	});

	it("refuses a malformed payload before touching GitHub", async () => {
		vi.mocked(executeGithubIssueAction).mockClear();
		await expect(
			executeAction(
				db,
				{
					id: "a2",
					userId: "owner-1",
					type: "file_github_issue",
					label: "x",
					payload: { op: "create", title: "T" },
					createdAt: new Date(),
				},
				"owner-1",
			),
		).rejects.toThrow(/body is required/);
		expect(executeGithubIssueAction).not.toHaveBeenCalled();
	});
});
