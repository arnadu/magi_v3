import type { IncomingMessage, ServerResponse } from "node:http";
import type { MonitorEventType } from "../monitor-server.js";
import type { RouteEntry } from "./types.js";

export interface PauseResumeDeps {
	pausedAgents: Set<string>;
	push: (type: MonitorEventType, payload: unknown) => void;
	statusPayload: () => Promise<unknown>;
	readAgentId: (
		req: IncomingMessage,
		res: ServerResponse,
	) => Promise<string | null>;
}

/** POST /pause-agent, /resume-agent — per-agent pause toggled from the dashboard. */
export function createPauseResumeRoutes(deps: PauseResumeDeps): RouteEntry[] {
	return [
		{
			method: "POST",
			path: "/pause-agent",
			async handler({ req, res }) {
				const agentId = await deps.readAgentId(req, res);
				if (agentId === null) return;
				deps.pausedAgents.add(agentId);
				console.log(`[monitor] Agent "${agentId}" paused`);
				deps.push("agent-paused", { agentId });
				deps.push("status", await deps.statusPayload());
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, paused: [...deps.pausedAgents] }));
			},
		},
		{
			method: "POST",
			path: "/resume-agent",
			async handler({ req, res }) {
				const agentId = await deps.readAgentId(req, res);
				if (agentId === null) return;
				deps.pausedAgents.delete(agentId);
				console.log(`[monitor] Agent "${agentId}" resumed`);
				deps.push("agent-resumed", { agentId });
				deps.push("status", await deps.statusPayload());
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, paused: [...deps.pausedAgents] }));
			},
		},
	];
}
