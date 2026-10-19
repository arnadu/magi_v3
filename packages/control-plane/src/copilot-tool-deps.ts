/**
 * What every control-plane copilot tool receives, and the small helpers they
 * share. The user id is the session's own; every query a tool makes is
 * scoped to it.
 */

import type { ToolResult } from "@magi/agent-runtime-worker";
import type { Db } from "mongodb";
import { monitorAuthHeaders } from "./monitor-token.js";
import type { PendingActionsStore } from "./pending-actions.js";

export interface CopilotToolDeps {
	db: Db;
	/** Push an SSE event to the copilot chat channel. */
	pushEvent: (type: string, data: unknown) => void;
	/** Proposed-but-unconfirmed actions. */
	pending: PendingActionsStore;
	userId: string;
}

export function ok(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

export function err(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

/** HTTP GET to the monitor server running on a mission's execution machine. */
export async function monitorFetch(
	privateIp: string,
	missionId: string,
	path: string,
): Promise<string> {
	const url = `http://[${privateIp}]:4000${path}`;
	const res = await fetch(url, {
		headers: monitorAuthHeaders(missionId),
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok)
		throw new Error(`Monitor server ${privateIp} returned ${res.status}`);
	return res.text();
}
