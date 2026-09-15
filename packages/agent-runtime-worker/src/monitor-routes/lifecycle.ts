import type { MonitorEventType } from "../monitor-server.js";
import type { RouteEntry } from "./types.js";

export interface LifecycleDeps {
	push: (type: MonitorEventType, payload: unknown) => void;
	onStop: () => void;
}

/** POST /stop — graceful daemon shutdown requested from the dashboard. */
export function createLifecycleRoutes(deps: LifecycleDeps): RouteEntry[] {
	return [
		{
			method: "POST",
			path: "/stop",
			handler({ res }) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				console.log("[monitor] Stop requested via dashboard");
				deps.push("shutdown", { reason: "operator-stop" });
				deps.onStop();
			},
		},
	];
}
