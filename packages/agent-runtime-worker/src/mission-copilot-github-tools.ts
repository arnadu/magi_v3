import { Type } from "@sinclair/typebox";
import type { MissionCopilotToolDeps } from "./mission-copilot-tool-deps.js";
import { err, ok } from "./mission-copilot-tool-result.js";
import type { MagiTool, ToolResult } from "./tools.js";

function listGithubIssuesTool(deps: MissionCopilotToolDeps): MagiTool {
	const { missionId } = deps;
	return {
		name: "ListGithubIssues",
		description:
			"Search open issues in the MAGI_V3 repo — call before filing, to avoid duplicates.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search text" })),
		}),
		async execute(_id, args) {
			const query = args.query as string | undefined;
			const qs = new URLSearchParams({ missionId });
			if (query) qs.set("query", query);
			return controlPlaneFetch(
				deps,
				`/api/mission-copilot/github/issues?${qs}`,
				{
					method: "GET",
				},
			);
		},
	};
}

function reportGithubIssueTool(deps: MissionCopilotToolDeps): MagiTool {
	const { missionId } = deps;
	return {
		name: "ReportGithubIssue",
		description:
			"Propose a new GitHub issue for a genuine platform bug (not a mission-content problem). Nothing is filed by this call: the proposal appears as a confirmation card in the operator's cockpit and is created only when they confirm — the issue tracker is public. Auto-labeled mission-copilot and tagged with this mission's id server-side.",
		parameters: Type.Object({
			title: Type.String(),
			body: Type.String(),
			labels: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, args) {
			const title = args.title as string;
			const body = args.body as string;
			const labels = args.labels as string[] | undefined;
			return controlPlaneFetch(deps, "/api/mission-copilot/github/issue", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ missionId, title, body, labels }),
			});
		},
	};
}

// ─── Family G — GitHub / Platform Bug Reporting ──────────────────────────
// GH_TOKEN never reaches the execution plane — every call here goes
// through the control-plane proxy (Phase 5), which re-derives and
// compares the mission's own MONITOR_TOKEN rather than trusting a
// missionId the request body claims.

async function controlPlaneFetch(
	{
		controlPlaneUrl,
		monitorToken,
	}: Pick<MissionCopilotToolDeps, "controlPlaneUrl" | "monitorToken">,
	path: string,
	init: RequestInit,
): Promise<ToolResult> {
	if (!controlPlaneUrl) {
		return err(
			"GitHub reporting is unavailable — no control plane URL configured (expected in local dev).",
		);
	}
	try {
		const res = await fetch(`${controlPlaneUrl}${path}`, {
			...init,
			headers: { "x-monitor-token": monitorToken, ...init.headers },
			signal: AbortSignal.timeout(15_000),
		});
		const body = await res.text();
		if (!res.ok) return err(`GitHub proxy returned ${res.status}: ${body}`);
		return ok(body);
	} catch (e) {
		return err(`Failed to reach control plane: ${(e as Error).message}`);
	}
}

export function createGithubTools(deps: MissionCopilotToolDeps) {
	return {
		listGithubIssues: listGithubIssuesTool(deps),
		reportGithubIssue: reportGithubIssueTool(deps),
	};
}
