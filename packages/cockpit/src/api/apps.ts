/**
 * Interactive apps (ADR-0037). The list and the start/stop/remove controls
 * reach the mission machine through the control plane's proxy; opening goes
 * to the control plane itself, which returns a one-time URL on the apps host.
 */

import { api, mp, request } from "./http";

/** An app as the mission machine reports it (never its capability). */
export interface MissionApp {
	name: string;
	owner: string;
	kind: "jupyter" | "gradio" | "site";
	description: string;
	status: "starting" | "running" | "stopped" | "failed";
	lastError?: string;
	lastOpenedAt?: string;
	rssMb?: number;
	restartsLastHour: number;
}

export type AppAction = "start" | "stop" | "remove";

export interface OpenedApp {
	/** One-time ticket URL: opens the app once, within 60 seconds. */
	url: string;
	/** The app's own address: works again in this browser for 12 hours; anyone else is sent to sign in. */
	link: string;
	app: string;
	missionId: string;
}

export function fetchApps(missionId: string): Promise<MissionApp[]> {
	return api<MissionApp[]>(`/missions/${mp(missionId)}/apps`);
}

export async function controlMissionApp(
	missionId: string,
	name: string,
	action: AppAction,
): Promise<void> {
	await request(`/missions/${mp(missionId)}/apps/${mp(name)}/${action}`, {
		method: "POST",
	});
}

export async function openMissionApp(
	missionId: string,
	name: string,
): Promise<OpenedApp> {
	const res = await request(
		`/api/missions/${mp(missionId)}/apps/${mp(name)}/open`,
		{ method: "POST" },
	);
	return (await res.json()) as OpenedApp;
}

/** The apps host sent the operator back (a copied link, an expired session): a fresh ticket. */
export async function reopenApp(capability: string): Promise<OpenedApp> {
	const res = await request("/api/apps/reopen", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ capability }),
	});
	return (await res.json()) as OpenedApp;
}
