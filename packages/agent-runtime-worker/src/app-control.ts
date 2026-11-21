/**
 * Starting, stopping and removing an app (operation app.control), for every
 * caller: an agent's request file, the mission copilot, the operator through
 * the cockpit, the control plane opening a stopped app. Who may act on which
 * app, and who is told, is decided here once.
 */

import type { MissionAppDoc } from "@magi/agent-config";
import type { AppSupervisor, Outcome } from "./app-supervisor.js";

export type AppAction = "start" | "stop" | "remove";

/** Who asks: an agent (by its id), or the operator (the cockpit, or the control plane on the operator's behalf). */
export type AppCaller = { kind: "agent"; id: string } | { kind: "operator" };

export interface AppControlDeps {
	supervisor: Pick<AppSupervisor, "start" | "stop" | "remove">;
	store: { get(name: string): Promise<MissionAppDoc | null> };
	/** Agents that may act on any app (the mission copilot). */
	actsOnAny: ReadonlySet<string>;
	notify(agentId: string, subject: string, body: string): Promise<void>;
}

export async function controlApp(
	deps: AppControlDeps,
	name: string,
	action: AppAction,
	by: AppCaller,
): Promise<Outcome> {
	const app = await deps.store.get(name);
	if (!app) return { ok: false, message: `no app named ${name}` };
	const who = by.kind === "operator" ? "the operator" : by.id;
	if (by.kind === "agent" && app.owner !== by.id && !deps.actsOnAny.has(by.id))
		return { ok: false, message: `app ${name} belongs to ${app.owner}` };
	const r =
		action === "start"
			? await deps.supervisor.start(name)
			: action === "stop"
				? await deps.supervisor.stop(name, `stopped by ${who}`)
				: await deps.supervisor.remove(name);
	const byOwner = by.kind === "agent" && by.id === app.owner;
	if (r.ok && action !== "start" && !byOwner) {
		const done = action === "stop" ? "stopped" : "removed";
		await deps.notify(
			app.owner,
			`App ${name} ${done}`,
			`${who} ${done} your app ${name}.`,
		);
	}
	return r;
}
