/**
 * Opening an app for the operator (operation app.open, ADR-0037 decision 3),
 * the control plane's part: one function for the cockpit's Open and for the
 * apps host's "open it again" (by capability). It checks that the caller owns
 * the mission, starts a stopped app and waits for it to answer, gives the app
 * its slot, and returns a one-time ticket URL on that slot of the apps host.
 */

import {
	type MissionAppDoc,
	signAppTicket,
	storedCollection,
} from "@magi/agent-config";
import type { Db } from "mongodb";
import { assignSlot, NoFreeSlotError } from "./slots.js";

const START_WAIT_MS = 90_000;
const POLL_MS = 1_000;

export interface OpenAppDeps {
	db: Db;
	ticketKey: string;
	/** `https://magi-apps-<suffix>.fly.dev`, without a port. */
	appsHostUrl: string;
	/** Ask the mission machine to start the app (its monitor route, as the operator). */
	startApp(
		privateIp: string,
		missionId: string,
		name: string,
	): Promise<{ ok: boolean; message: string }>;
	/** The tenant rule (auth-scope.ts), passed in: this layer may not import the edge's. */
	ownerFilter(caller: Caller): { userId?: string };
	now?: () => Date;
	sleep?: (ms: number) => Promise<void>;
}

export interface Caller {
	userId: string;
	isAdmin: boolean;
}

export type OpenAppResult =
	| { ok: true; url: string; link: string; app: string; missionId: string }
	| { ok: false; status: 404 | 409 | 503; message: string };

export async function openApp(
	deps: OpenAppDeps,
	caller: Caller,
	which: { missionId: string; name: string } | { capability: string },
): Promise<OpenAppResult> {
	if (!deps.ticketKey || !deps.appsHostUrl)
		return {
			ok: false,
			status: 503,
			message: "interactive apps are not configured on this deployment",
		};
	const apps = storedCollection(deps.db, "missionApps");
	const app = await apps.findOne(
		"capability" in which
			? { capability: which.capability }
			: { missionId: which.missionId, name: which.name },
	);
	const mission =
		app &&
		(await storedCollection(deps.db, "missions").findOne({
			missionId: app.missionId,
			...deps.ownerFilter(caller),
		}));
	// Anyone but the owner (or an admin) learns nothing, not even that the app exists.
	if (!app || !mission)
		return { ok: false, status: 404, message: "no such app" };
	if (mission.status !== "running" || !mission.privateIp)
		return {
			ok: false,
			status: 409,
			message: `mission ${mission.missionId} is not running; resume it, then open the app`,
		};

	const ready = await ensureRunning(deps, app, mission.privateIp);
	if (!ready.ok) return { ok: false, status: 409, message: ready.message };

	let slot: number;
	try {
		slot = await assignSlot(apps, app, deps.now?.() ?? new Date());
	} catch (e) {
		if (e instanceof NoFreeSlotError)
			return { ok: false, status: 409, message: e.message };
		throw e;
	}
	const base = `${deps.appsHostUrl.replace(/\/$/, "")}:${slot}`;
	const ticket = signAppTicket(
		{
			userId: caller.userId,
			missionId: app.missionId,
			app: app.name,
			capability: app.capability,
			slot,
			machine: mission.privateIp,
		},
		deps.ticketKey,
		(deps.now?.() ?? new Date()).getTime(),
	);
	return {
		ok: true,
		url: `${base}/t/${ticket}`,
		link: `${base}/a/${app.capability}/`,
		app: app.name,
		missionId: app.missionId,
	};
}

/** Start a stopped or failed app (within the mission's limit), then wait until it answers. */
async function ensureRunning(
	deps: OpenAppDeps,
	app: MissionAppDoc,
	privateIp: string,
): Promise<{ ok: boolean; message: string }> {
	if (app.status === "running") return { ok: true, message: "running" };
	if (app.status !== "starting") {
		const r = await deps.startApp(privateIp, app.missionId, app.name);
		if (!r.ok) return r;
	}
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const apps = storedCollection(deps.db, "missionApps");
	for (let waited = 0; waited < START_WAIT_MS; waited += POLL_MS) {
		await sleep(POLL_MS);
		const now = await apps.findOne({
			missionId: app.missionId,
			name: app.name,
		});
		if (now?.status === "running") return { ok: true, message: "running" };
		if (!now || now.status === "failed" || now.status === "stopped")
			return {
				ok: false,
				message: `app ${app.name} did not start${now?.lastError ? `: ${now.lastError}` : ""}`,
			};
	}
	return {
		ok: false,
		message: `app ${app.name} is still starting; open it again in a moment`,
	};
}
