import type { MonitorEventType } from "../monitor-server.js";
import type { RouteEntry } from "./types.js";

/**
 * Accessor functions, not plain values: stepResolve/stepEnabled/started/
 * startResolve are mutated in place on the MonitorServer instance by these
 * very routes (and read by other, not-yet-migrated code — statusPayload,
 * the orchestrator's step-mode wiring). A deps object built once at
 * construction time can't hold these by value without going stale the
 * moment any of them changes.
 */
export interface RunControlDeps {
	getStepResolve: () => (() => void) | null;
	setStepResolve: (fn: (() => void) | null) => void;
	getStepEnabled: () => boolean;
	setStepEnabled: (enabled: boolean) => void;
	getStarted: () => boolean;
	setStarted: (started: boolean) => void;
	getStartResolve: () => (() => void) | null;
	setStartResolve: (fn: (() => void) | null) => void;
	push: (type: MonitorEventType, payload: unknown) => void;
}

/** POST /step, /toggle-step, /start — the dashboard's manual run controls. */
export function createRunControlRoutes(deps: RunControlDeps): RouteEntry[] {
	return [
		{
			method: "POST",
			path: "/step",
			handler({ res }) {
				const stepResolve = deps.getStepResolve();
				if (stepResolve) {
					stepResolve();
					deps.setStepResolve(null);
					deps.push("step-resumed", {});
					console.log("[monitor] Step advanced via dashboard");
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({ ok: true, stepEnabled: deps.getStepEnabled() }),
				);
			},
		},
		{
			method: "POST",
			path: "/toggle-step",
			handler({ res }) {
				const stepEnabled = !deps.getStepEnabled();
				deps.setStepEnabled(stepEnabled);
				const stepResolve = deps.getStepResolve();
				if (!stepEnabled && stepResolve) {
					stepResolve();
					deps.setStepResolve(null);
					deps.push("step-resumed", {});
				}
				console.log(`[monitor] Step mode: ${stepEnabled ? "ON" : "OFF"}`);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, stepEnabled }));
			},
		},
		{
			method: "POST",
			path: "/start",
			handler({ res }) {
				if (!deps.getStarted()) {
					deps.setStarted(true);
					const startResolve = deps.getStartResolve();
					if (startResolve) {
						startResolve();
						deps.setStartResolve(null);
					}
					deps.push("started", {});
					console.log("[monitor] Mission started via dashboard");
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			},
		},
	];
}
