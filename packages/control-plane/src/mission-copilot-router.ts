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
import { GITHUB_REPO, ghFetch } from "./github.js";
import { deriveMonitorToken } from "./monitor-token.js";

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
	if (!expected || typeof provided !== "string" || provided !== expected) {
		res.status(401).json({ error: "Unauthorized" });
		return;
	}
	next();
}

export function createMissionCopilotRouter(_db: Db): ExpressRouter {
	const router = Router();

	router.use((req, res, next) => verifyMissionToken(req, res, next));

	router.get("/github/issues", async (req, res) => {
		const query = req.query.query as string | undefined;
		const qs = query ? `&q=${encodeURIComponent(query)}` : "";
		try {
			const ghRes = await ghFetch(
				`/repos/${GITHUB_REPO}/issues?state=open&per_page=50${qs}`,
			);
			if (!ghRes.ok) {
				res.status(502).json({ error: `GitHub API returned ${ghRes.status}` });
				return;
			}
			const issues = (await ghRes.json()) as Array<{
				number: number;
				title: string;
				state: string;
				labels: Array<{ name: string }>;
			}>;
			res.json(
				issues.map((i) => ({
					number: i.number,
					title: i.title,
					state: i.state,
					labels: i.labels.map((l) => l.name),
				})),
			);
		} catch (e) {
			res.status(502).json({ error: (e as Error).message });
		}
	});

	router.post("/github/issue", async (req, res) => {
		const missionId = req.body?.missionId as string;
		const title = req.body?.title as string | undefined;
		const body = req.body?.body as string | undefined;
		const labels = req.body?.labels as string[] | undefined;
		if (typeof title !== "string" || title.trim() === "") {
			res.status(400).json({ error: "title is required" });
			return;
		}
		if (typeof body !== "string" || body.trim() === "") {
			res.status(400).json({ error: "body is required" });
			return;
		}
		// Server-side, not tool-side: forced label and provenance footer can't
		// be stripped or spoofed by whatever the mission copilot's tool call
		// actually sent (F-023 — no confirmation gate on this write yet).
		const forcedLabels = Array.from(
			new Set(["mission-copilot", ...(Array.isArray(labels) ? labels : [])]),
		);
		const footer = `\n\n---\n_Filed by the mission copilot for mission \`${missionId}\`._`;
		try {
			const ghRes = await ghFetch(`/repos/${GITHUB_REPO}/issues`, {
				method: "POST",
				body: JSON.stringify({
					title,
					body: `${body}${footer}`,
					labels: forcedLabels,
				}),
			});
			if (!ghRes.ok) {
				const text = await ghRes.text();
				res
					.status(502)
					.json({ error: `GitHub API returned ${ghRes.status}: ${text}` });
				return;
			}
			const issue = (await ghRes.json()) as {
				number: number;
				html_url: string;
			};
			res.json({ ok: true, issueNumber: issue.number, url: issue.html_url });
		} catch (e) {
			res.status(502).json({ error: (e as Error).message });
		}
	});

	return router;
}
