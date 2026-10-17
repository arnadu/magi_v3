/**
 * GitHub proxy for mission-copilot agents (ADR-0016, Phase 5).
 *
 * Lets an execution-plane mission copilot file/search GitHub issues without
 * GH_TOKEN ever reaching the execution plane — the same reasoning that
 * already keeps MONITOR_SIGNING_KEY control-plane-only (TB-11). Each
 * mission's daemon already holds a per-mission MONITOR_TOKEN, derived from
 * that signing key; this router re-derives and compares it rather than
 * trusting a missionId the request body claims — the token, not the field,
 * is what's unforgeable (a request claiming a missionId it doesn't hold the
 * matching token for still gets 401).
 *
 * Machine-to-machine auth, not browser/Firebase — mounted in index.ts before
 * app.use(requireAuth).
 *
 * Verified critical divergence from MonitorServer's own tokenOk(): that
 * fails *open* when MONITOR_SIGNING_KEY is unset (correct for a
 * loopback-only, WireGuard-internal boundary in dev). This router is public
 * HTTPS on the control plane — it must fail *closed* on a missing/empty
 * signing key, or an unconfigured deployment would accept any request from
 * anyone. See mission-copilot-router.unit.test.ts's explicit regression test
 * for this.
 */

import type { Router as ExpressRouter, Request, Response } from "express";
import { Router } from "express";
import type { Db } from "mongodb";
import { asyncRoutes } from "./async-handler.js";
import { safeEqual } from "./auth.js";
import {
	type ProposeForOwnerDeps,
	proposeIssueForMissionOwner,
	searchOpenIssues,
} from "./github-issues.js";
import { deriveMonitorToken } from "./monitor-token.js";
import {
	requestUpgrade,
	revertUpgrade,
	type UpgradeResult,
} from "./resource-upgrade.js";

/** Verify the caller holds the exact MONITOR_TOKEN for the missionId it claims. Fails closed on a missing signing key. */
export function verifyMissionToken(
	req: Request,
	res: Response,
	next: () => void,
): void {
	const missionId =
		(req.body?.missionId as string | undefined) ??
		(req.query?.missionId as string | undefined);
	if (typeof missionId !== "string" || missionId.trim() === "") {
		res.status(400).json({ error: "missionId is required" });
		return;
	}
	// deriveMonitorToken returns "" when MONITOR_SIGNING_KEY is unset — an
	// empty expected token must never be treated as "no auth required" here
	// (unlike MonitorServer's loopback-only tokenOk()). Reject explicitly
	// before comparing, so an empty provided header can never match.
	const expected = deriveMonitorToken(missionId);
	const provided = req.headers["x-monitor-token"];
	if (
		!expected ||
		typeof provided !== "string" ||
		!safeEqual(provided, expected)
	) {
		res.status(401).json({ error: "Unauthorized" });
		return;
	}
	next();
}

/**
 * Wrap a resource-upgrade operation as a route handler. Runs after
 * verifyMissionToken, so `req.body.missionId` is the mission whose token the
 * caller holds; the service never sees any other id.
 */
export function resourceRoute(
	run: (missionId: string, body: unknown) => Promise<UpgradeResult>,
) {
	return async (req: Request, res: Response): Promise<void> => {
		const missionId = req.body?.missionId as string;
		try {
			const result = await run(missionId, req.body);
			res.status(result.status).json(result.body);
		} catch (e) {
			console.error(
				`[mission-copilot-router] Resource request failed { path: "${req.path}", missionId: "${missionId}", error: "${(e as Error).message}" }`,
			);
			res
				.status(500)
				.json({ error: "Internal error handling the resource request." });
		}
	};
}

export function createMissionCopilotRouter(
	db: Db,
	proposals: Pick<ProposeForOwnerDeps, "pending" | "notify">,
): ExpressRouter {
	const router = Router();
	const routes = asyncRoutes(router);
	const deps: ProposeForOwnerDeps = { db, ...proposals };

	router.use((req, res, next) => verifyMissionToken(req, res, next));

	// Temporary machine upgrades (ADR-0031). Renewing is the same call as
	// requesting, with an unchanged shape.
	router.post(
		"/resources/upgrade",
		resourceRoute((missionId, body) => requestUpgrade(db, missionId, body)),
	);
	router.post(
		"/resources/revert",
		resourceRoute((missionId) =>
			revertUpgrade(db, missionId, { reason: "requested" }),
		),
	);

	routes.get("/github/issues", async (req, res) => {
		const query = req.query.query as string | undefined;
		try {
			const issues = await searchOpenIssues({ q: query });
			res.json(
				issues.map((i) => ({
					number: i.number,
					title: i.title,
					state: "open",
					labels: i.labels,
				})),
			);
		} catch (e) {
			res.status(502).json({ error: (e as Error).message });
		}
	});

	// A mission copilot does not file issues: it proposes one, and the pending
	// action lands in the mission owner's cockpit for confirmation (F-023,
	// EXFIL1 — the repository is public and the copilot's context carries
	// teammates' output, which may quote untrusted sources). The forced
	// `mission-copilot` label and the provenance block are applied at
	// execution, server-side.
	routes.post("/github/issue", async (req, res) => {
		const missionId = req.body?.missionId as string;
		try {
			const result = await proposeIssueForMissionOwner(deps, missionId, {
				title: req.body?.title,
				body: req.body?.body,
				labels: req.body?.labels,
			});
			res.json({
				ok: true,
				proposed: true,
				pendingActionId: result.pendingActionId,
				message: result.message,
			});
		} catch (e) {
			const msg = (e as Error).message;
			res
				.status(/required|invalid|must be|exceeds/.test(msg) ? 400 : 502)
				.json({
					error: msg,
				});
		}
	});

	return router;
}
