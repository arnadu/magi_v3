import type { ServerResponse } from "node:http";
import type { AgentInfo } from "../monitor-server.js";
import type { RouteEntry } from "./types.js";

export interface DashboardShellDeps {
	/** Shared hub — also read directly/indirectly by several other clusters (budget, run-control, pause/resume) not yet migrated. */
	statusPayload: () => Promise<unknown>;
	clients: Set<ServerResponse>;
	agents: AgentInfo[];
}

/** `/events` (SSE stream), `/team`, `/status` — tightly coupled via `statusPayload`/the client registry. */
export function createDashboardShellRoutes(
	deps: DashboardShellDeps,
): RouteEntry[] {
	return [
		{
			method: "GET",
			path: "/events",
			async handler({ req, res }) {
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				res.write("retry: 3000\n\n");
				res.write(
					`event: status\ndata: ${JSON.stringify(await deps.statusPayload())}\n\n`,
				);
				deps.clients.add(res);
				req.on("close", () => deps.clients.delete(res));
			},
		},
		{
			method: "GET",
			path: "/team",
			handler({ res }) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(deps.agents));
			},
		},
		{
			method: "GET",
			path: "/status",
			async handler({ res }) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(await deps.statusPayload()));
			},
		},
	];
}
