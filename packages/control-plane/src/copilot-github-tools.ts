import type { MagiTool, ToolResult } from "@magi/agent-runtime-worker";
import { Type } from "@sinclair/typebox";
import { type CopilotToolDeps, err, ok } from "./copilot-tool-deps.js";
import {
	type GithubIssuePayload,
	githubIssuePendingAction,
	parseGithubIssuePayload,
	searchOpenIssues,
} from "./github-issues.js";

// ─── B3: GitHub Issues ───────────────────────────────────────────────────
function listIssuesTool(_deps: CopilotToolDeps): MagiTool {
	return {
		name: "ListIssues",
		description:
			"List or search open GitHub Issues in the MAGI repository. " +
			"Use to check known bugs and deferred items before raising a new issue. " +
			"Optionally filter by label (bug, enhancement, deferred, ux, security) and/or search text.",
		parameters: Type.Object({
			label: Type.Optional(
				Type.String({
					description: "Filter by label name (omit for all open issues)",
				}),
			),
			q: Type.Optional(
				Type.String({
					description:
						"Search text (GitHub issue search syntax); omit to list the newest",
				}),
			),
		}),
		async execute(_id, args) {
			const label = args.label as string | undefined;
			const q = args.q as string | undefined;
			try {
				const issues = await searchOpenIssues({ label, q });
				if (issues.length === 0) return ok("(no open issues)");
				const rows = issues
					.map((i) => {
						const labels = i.labels.join(", ") || "(no labels)";
						const first = i.body.split("\n")[0].slice(0, 120);
						return `#${i.number} [${labels}] ${i.title}${first ? `\n  ${first}` : ""}`;
					})
					.join("\n\n");
				return ok(rows);
			} catch (e) {
				return err(`GitHub API error: ${(e as Error).message}`);
			}
		},
	};
}

// The three GitHub write tools do not write. Each validates its arguments
// into a `file_github_issue` payload and proposes it for operator
// confirmation, exactly like ProposeAction — the repository is public and
// a copilot's context can carry text from untrusted sources (F-021).
export async function proposeGithubIssue(
	{ userId, pending, pushEvent }: CopilotToolDeps,
	raw: unknown,
): Promise<ToolResult> {
	let payload: GithubIssuePayload;
	try {
		payload = parseGithubIssuePayload(raw);
	} catch (e) {
		return err((e as Error).message);
	}
	const action = githubIssuePendingAction(userId, payload);
	await pending.add(action);
	pushEvent("copilot-action", {
		id: action.id,
		type: action.type,
		label: action.label,
		payload: action.payload,
	});
	return ok(
		`Proposed for operator confirmation: ${action.label} (id: ${action.id}). ` +
			"Nothing is written to GitHub until the operator confirms the card.",
	);
}
function createIssueTool(deps: CopilotToolDeps): MagiTool {
	return {
		name: "CreateIssue",
		description:
			"Propose a new GitHub Issue in the MAGI repository for operator confirmation. " +
			"Use to record bugs or deferred improvements discovered during a session. " +
			"Always call ListIssues first to avoid duplicates. " +
			"Good body structure: **Observed:** … **Expected:** … **Impact:** … **Proposed fix:** … " +
			"The issue is created only when the operator confirms the card.",
		parameters: Type.Object({
			title: Type.String({
				description: "Issue title — concise, action-oriented",
			}),
			body: Type.String({ description: "Issue body (markdown)" }),
			labels: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Labels to apply: bug, enhancement, deferred, ux, security",
				}),
			),
		}),
		async execute(_id, args) {
			return proposeGithubIssue(deps, { op: "create", ...(args as object) });
		},
	};
}

function closeIssueTool(deps: CopilotToolDeps): MagiTool {
	return {
		name: "CloseIssue",
		description:
			"Propose closing a GitHub Issue (optionally with a closing comment) for operator confirmation.",
		parameters: Type.Object({
			number: Type.Number({ description: "Issue number" }),
			comment: Type.Optional(
				Type.String({ description: "Closing comment to add before closing" }),
			),
		}),
		async execute(_id, args) {
			return proposeGithubIssue(deps, { op: "close", ...(args as object) });
		},
	};
}

function addIssueCommentTool(deps: CopilotToolDeps): MagiTool {
	return {
		name: "AddIssueComment",
		description:
			"Propose a comment on an existing GitHub Issue for operator confirmation.",
		parameters: Type.Object({
			number: Type.Number({ description: "Issue number" }),
			body: Type.String({ description: "Comment text (markdown supported)" }),
		}),
		async execute(_id, args) {
			return proposeGithubIssue(deps, { op: "comment", ...(args as object) });
		},
	};
}

export function createGithubTools(deps: CopilotToolDeps) {
	return {
		listIssues: listIssuesTool(deps),
		createIssue: createIssueTool(deps),
		closeIssue: closeIssueTool(deps),
		addIssueComment: addIssueCommentTool(deps),
	};
}
