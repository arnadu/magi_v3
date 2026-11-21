/**
 * The cockpit's way to open an interactive app (ADR-0037): two routes over
 * one operation (`openApp`), behind the cockpit's sign-in.
 *
 *   POST /api/missions/:id/apps/:name/open   the Open button
 *   POST /api/apps/reopen {capability}        the apps host sent the operator
 *                                             back here (a copied link, an
 *                                             expired session, a moved machine)
 */

import type { Request, Response } from "express";
import { Router as createRouter, json } from "express";
import type { Db } from "mongodb";
import { type OpenAppDeps, openApp } from "./apps-host/open.js";
import { asyncRoutes, routeParam } from "./async-handler.js";
import { monitorAuthHeaders, monitorUrl } from "./monitor-token.js";

const START_TIMEOUT_MS = 15_000;

/** Ask the mission machine to start an app, as the operator (the monitor's app.control route). */
async function startOnMachine(
	privateIp: string,
	missionId: string,
	name: string,
) {
	try {
		const r = await fetch(
			monitorUrl(privateIp, `/apps/${encodeURIComponent(name)}/start`),
			{
				method: "POST",
				headers: monitorAuthHeaders(missionId),
				signal: AbortSignal.timeout(START_TIMEOUT_MS),
			},
		);
		const body = (await r.json().catch(() => ({}))) as { message?: string };
		return {
			ok: r.ok,
			message: body.message ?? `the mission machine answered ${r.status}`,
		};
	} catch (e) {
		console.error(
			`[apps] starting app ${name} on mission ${missionId} failed: ${(e as Error).message}; the operator is told to retry`,
		);
		return {
			ok: false,
			message: "the mission machine did not answer; try again in a moment",
		};
	}
}

export function createAppOpenRoutes(db: Db) {
	const deps: OpenAppDeps = {
		db,
		ticketKey: process.env.APPS_TICKET_KEY ?? "",
		appsHostUrl: process.env.APPS_HOST_URL ?? "",
		startApp: startOnMachine,
	};
	const caller = (req: Request) => ({
		userId: req.userId as string,
		isAdmin: req.isAdmin === true,
	});
	const answer = (res: Response, r: Awaited<ReturnType<typeof openApp>>) => {
		if (r.ok)
			res.json({
				url: r.url,
				link: r.link,
				app: r.app,
				missionId: r.missionId,
			});
		else res.status(r.status).json({ error: r.message });
	};

	const missionsRouter = createRouter();
	asyncRoutes(missionsRouter).post(
		"/:id/apps/:name/open",
		"app.open",
		async (req, res) => {
			answer(
				res,
				await openApp(deps, caller(req), {
					missionId: routeParam(req, "id"),
					name: routeParam(req, "name"),
				}),
			);
		},
	);

	const appsRouter = createRouter();
	asyncRoutes(appsRouter).post(
		"/reopen",
		"app.open",
		json({ limit: "1kb" }),
		async (req, res) => {
			const capability = (req.body as { capability?: unknown })?.capability;
			if (
				typeof capability !== "string" ||
				!/^[0-9a-f]{32}$/.test(capability)
			) {
				res.status(400).json({ error: "capability must be 32 hex characters" });
				return;
			}
			answer(res, await openApp(deps, caller(req), { capability }));
		},
	);
	return { missionsRouter, appsRouter };
}
