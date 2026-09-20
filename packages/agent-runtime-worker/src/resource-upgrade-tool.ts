/**
 * Mission-copilot tools for temporary machine upgrades (ADR-0031). Tier B:
 * registered for the mission-copilot only, next to SetMissionSpendCap and the
 * other Family D/E/G tools, so worker agents cannot call them — they ask the
 * mission-copilot by mailbox message instead, and the copilot decides.
 *
 * The control plane does the work (it alone holds the Fly credentials) over
 * the same per-mission-token channel as the GitHub proxy tools. `missionId`
 * is closure-supplied and never an LLM-facing parameter; the token, not the
 * field, is what the control plane trusts.
 *
 * A new upgrade replaces the mission's machine, which stops this very daemon
 * mid-request, so the copilot will normally not see the result of a
 * successful request: the control plane posts a message to the mission
 * (operator, mission-copilot, requesting agent) that it reads on restart.
 * Rejections and renewals, which do not restart anything, are returned here.
 */

import { Type } from "@sinclair/typebox";
import type { MagiTool, ToolResult } from "./tools.js";
import { truncate } from "./tools.js";

export interface ResourceUpgradeToolsConfig {
	missionId: string;
	/** Empty in local dev, where there is no control plane to call. */
	controlPlaneUrl: string;
	monitorToken: string;
	/** Injected for tests; defaults to the global fetch. */
	fetchFn?: typeof fetch;
}

const REQUEST_TIMEOUT_MS = 60_000;

const ok = (text: string): ToolResult => ({
	content: [{ type: "text", text: truncate(text) }],
});
const err = (text: string): ToolResult => ({
	content: [{ type: "text", text: truncate(text) }],
	isError: true,
});

/** The control plane's `{error}` message if the body is JSON, else the raw body. */
function errorText(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: unknown };
		if (typeof parsed.error === "string") return parsed.error;
	} catch {
		// not JSON
	}
	return body;
}

export function createResourceUpgradeTools(
	config: ResourceUpgradeToolsConfig,
): MagiTool[] {
	const { missionId, controlPlaneUrl, monitorToken } = config;
	const doFetch = config.fetchFn ?? fetch;

	async function call(
		path: string,
		payload: Record<string, unknown>,
	): Promise<ToolResult> {
		if (!controlPlaneUrl) {
			return err(
				"Machine upgrades are unavailable — no control plane URL is configured (expected in local dev).",
			);
		}
		try {
			const res = await doFetch(`${controlPlaneUrl}${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-monitor-token": monitorToken,
				},
				body: JSON.stringify({ missionId, ...payload }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const body = await res.text();
			if (res.status === 404) {
				return err(
					"The control plane does not support machine upgrades yet (HTTP 404). Nothing changed.",
				);
			}
			if (!res.ok) {
				return err(`Rejected (HTTP ${res.status}): ${errorText(body)}`);
			}
			return ok(body);
		} catch (e) {
			return err(
				`Could not reach the control plane: ${(e as Error).message}. Nothing may have changed — if the machine restarted, a message in this mission says what happened.`,
			);
		}
	}

	const requestResourceUpgrade: MagiTool = {
		name: "RequestResourceUpgrade",
		description:
			"Request a temporary upgrade to a bigger machine (CPU kind, CPUs, RAM) for a genuine compute burst. " +
			"A new upgrade REPLACES the mission's machine: every running agent turn is aborted and every background job re-runs from scratch " +
			"(the same as a manual suspend), so check who is mid-task before calling this, and read the request-resources skill first. " +
			"durationMinutes is required (no default) and at most 60; call again with the SAME shape before it expires to renew (no restart), " +
			"or with a different shape to resize. The machine returns to its default when the window ends. " +
			"Invalid or over-limit requests are rejected with the list of allowed shapes; there is also a cumulative 24 h cap that only the operator can reset. " +
			"You will normally not see the result of a successful new upgrade, because the restart stops you: a message posted to the mission tells you what happened when you restart.",
		parameters: Type.Object({
			cpuKind: Type.Union(
				[Type.Literal("shared"), Type.Literal("performance")],
				{
					description:
						"shared: cheap, bursty CPU, good for memory-heavy work; performance: dedicated CPU for sustained compute",
				},
			),
			cpus: Type.Integer({
				minimum: 1,
				description: "Number of CPUs (maximum 4)",
			}),
			memoryMb: Type.Integer({
				minimum: 256,
				description:
					"RAM in MB, a multiple of 256, within the range allowed for the CPU kind and count (maximum 16384)",
			}),
			durationMinutes: Type.Integer({
				minimum: 1,
				maximum: 60,
				description:
					"Required, no default. Minutes to keep this machine before it reverts unless renewed (1-60)",
			}),
			reason: Type.String({
				description:
					"Why the bigger machine is needed — shown to the operator and the requesting agent",
			}),
			requestedByAgentId: Type.Optional(
				Type.String({
					description:
						"Id of the teammate who asked for this, if any; they are told, and reminded before it expires",
				}),
			),
		}),
		async execute(_id, args) {
			return call("/api/mission-copilot/resources/upgrade", {
				cpuKind: args.cpuKind,
				cpus: args.cpus,
				memoryMb: args.memoryMb,
				durationMinutes: args.durationMinutes,
				reason: args.reason,
				...(args.requestedByAgentId !== undefined && {
					requestedByAgentId: args.requestedByAgentId,
				}),
			});
		},
	};

	const endResourceUpgrade: MagiTool = {
		name: "EndResourceUpgrade",
		description:
			"Return the mission to its default machine now, e.g. because the job that needed the bigger one is finished, to stop paying for it. " +
			"This restarts the machine like an upgrade does (running turns abort, background jobs re-run from scratch), so only call it when nothing is mid-task. " +
			"Not needed when the window is about to expire on its own. Fails if the machine was resized in the last 5 minutes.",
		parameters: Type.Object({}),
		async execute() {
			return call("/api/mission-copilot/resources/revert", {});
		},
	};

	return [requestResourceUpgrade, endResourceUpgrade];
}
