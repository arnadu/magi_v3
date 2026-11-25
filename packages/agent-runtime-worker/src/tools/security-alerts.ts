/**
 * SecurityAlerts (operation `security.read-alerts`): the repository's open code-scanning and
 * Dependabot alerts, read through the control plane with the mission's token. Built only for the
 * agents the mission's admin-set `securityAlerts.agents` names; the control plane checks the same
 * list, and that the mission's owner is a platform admin, on every call. No GitHub token is on
 * this machine.
 */
import { Type } from "@sinclair/typebox";
import type { MagiTool, ToolResult } from "../tools.js";

export interface SecurityAlertsClient {
	controlPlaneUrl: string;
	monitorToken: string;
	missionId: string;
	fetch?: typeof fetch;
}

function text(t: string, isError = false): ToolResult {
	return {
		content: [{ type: "text", text: t }],
		...(isError ? { isError } : {}),
	};
}

export function createSecurityAlertsTool(
	client: SecurityAlertsClient,
	agentId: string,
): MagiTool {
	return {
		name: "SecurityAlerts",
		operation: "security.read-alerts",
		description:
			"List the repository's open security alerts (code scanning and Dependabot) as JSON, to triage them. Private: never quote them in a public place (an issue, a commit, a pull request).",
		parameters: Type.Object({}),
		async execute() {
			if (!client.controlPlaneUrl) {
				return text(
					"SecurityAlerts is unavailable: no control plane URL (local development).",
					true,
				);
			}
			const qs = new URLSearchParams({ missionId: client.missionId, agentId });
			try {
				const res = await (client.fetch ?? fetch)(
					`${client.controlPlaneUrl}/api/mission-copilot/github/alerts?${qs}`,
					{
						headers: { "x-monitor-token": client.monitorToken },
						signal: AbortSignal.timeout(60_000),
					},
				);
				const body = await res.text();
				if (!res.ok) {
					const why =
						res.status === 404
							? "this agent is not allowed to read security alerts"
							: body.slice(0, 300);
					return text(`SecurityAlerts: ${res.status}: ${why}`, true);
				}
				return text(body);
			} catch (e) {
				return text(
					`SecurityAlerts: the control plane did not answer: ${(e as Error).message}`,
					true,
				);
			}
		},
	};
}
