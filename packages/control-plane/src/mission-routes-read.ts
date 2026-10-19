/**
 * Missions API — Listing, one mission, its conversations and roster, and the operator's mail actions.
 * Registered by `createMissionsRouter` (missions.ts) in the original order.
 */

import { storedCollection } from "@magi/agent-config";
import type { RequestHandler } from "express";
import type { AsyncRoutes } from "./async-handler.js";
import { getMachineState } from "./fly-machines.js";
import { postMailbox } from "./mailbox-writer.js";
import type { MissionRouteDeps } from "./mission-scope.js";
import { userFilter } from "./mission-scope.js";
import { summarizeMissions } from "./mission-stats-summary.js";
import { liveStateToStatus } from "./mission-status.js";
import { monitorAuthHeaders } from "./monitor-token.js";

// List missions (scoped to current user unless admin).
function listMissions({ col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const missions = await col
			.find(userFilter(req), { sort: { createdAt: -1 } })
			.toArray();
		res.json(missions);
	};
}

// Per-mission telemetry — registered before /:id to avoid route shadowing.
function getStats({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const missions = await col
			.find(
				{ ...userFilter(req), status: { $ne: "destroyed" } },
				{ projection: { missionId: 1, _id: 0 } },
			)
			.toArray();
		res.json(
			await summarizeMissions(
				db,
				missions.map((m) => m.missionId),
			),
		);
	};
}

// Get one mission.
function getMission({ col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		// Refresh live machine state from Fly. Skipped for "error": a failed
		// resume sets status to "error" but deliberately leaves the stale
		// machineId of the (now possibly-deleted) old machine in place — a live
		// lookup against it would silently overwrite "error" (and errorMessage's
		// explanation) with whatever the dead machine reports. The mission stays
		// in "error" until an operator explicitly resumes (success clears it) or
		// destroys it. "destroyed" is skipped because only DELETE /:id produces
		// it, and that machine no longer exists by definition.
		// Also skipped while a resize has the machine stopped on purpose: the live
		// state would otherwise flip the mission to "suspended" mid-resize.
		if (
			mission.machineId &&
			mission.status !== "destroyed" &&
			mission.status !== "error" &&
			!mission.resize?.claimedAt
		) {
			try {
				const liveState = await getMachineState(mission.machineId);
				const mapped = liveStateToStatus(liveState);
				if (mapped !== null && mapped !== mission.status) {
					await col.updateOne(
						{ missionId: req.params.id },
						{ $set: { status: mapped, updatedAt: new Date() } },
					);
					mission.status = mapped;
				}
			} catch {
				// Fly API unavailable — return cached status.
			}
		}
		res.json(mission);
	};
}

// All mailbox messages the operator participates in (sender or recipient), for
// the cockpit Conversations panel. The client folds these into threads by
// participant set. read/unread reuses the mailbox `readBy` array.
function getConversations({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		// Newest 500 first (descending), then reversed back to chronological
		// order for the client's thread-builder (ConversationsPanel.tsx's
		// buildThreads expects ascending order). Sorting ascending with the
		// same limit() — the previous code — takes the OLDEST 500 instead:
		// once a mission's operator thread passed 500 messages, everything
		// after the 500th-oldest was silently dropped forever, even though it
		// was still in MongoDB (found live on meteo-textbook-20260730, whose
		// resume-recovery traffic tipped it just over the cap).
		const msgs = (
			await storedCollection(db, "mailbox")
				.find({
					missionId: req.params.id,
					$or: [{ from: "user" }, { to: "user" }],
				})
				.sort({ timestamp: -1 })
				.limit(500)
				.toArray()
		).reverse();
		res.json(
			msgs.map((m) => ({
				id: m.id,
				from: m.from,
				to: Array.isArray(m.to) ? m.to : [m.to],
				subject: m.subject,
				body: m.body,
				timestamp: m.timestamp,
				read:
					m.from === "user" ||
					(Array.isArray(m.readBy) && m.readBy.includes("user")),
			})),
		);
	};
}

// The mission's agent roster, for the compose recipient chips.
function getAgents({ col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		// Prefer the live daemon's actual roster over the stored structured
		// config: the mission copilot (ADR-0016) is injected in-memory only at
		// daemon startup, never written back to `agents`, so a static read
		// alone would never include it — the cockpit would never be able to
		// show or address it, no matter what its id is.
		if (mission.status === "running" && mission.privateIp) {
			try {
				const host = mission.privateIp.includes(":")
					? `[${mission.privateIp}]`
					: mission.privateIp;
				// 10s, matching every other control-plane→execution-plane call
				// (copilot-tools.ts's monitorFetch/monitorPost) — 5s was too
				// tight for this cross-app WireGuard hop and caused silent,
				// undiagnosable fallback to the stale static roster.
				const liveRes = await fetch(`http://${host}:4000/team`, {
					headers: monitorAuthHeaders(mission.missionId),
					signal: AbortSignal.timeout(10_000),
				});
				if (liveRes.ok) {
					const live = (await liveRes.json()) as Array<{
						id: string;
						name: string;
					}>;
					res.json(live.map((a) => ({ id: a.id, name: a.name ?? a.id })));
					return;
				}
				console.error(
					`[missions] live /team fetch returned ${liveRes.status} { missionId: "${req.params.id}", privateIp: "${mission.privateIp}" } — falling back to stored config`,
				);
			} catch (e) {
				console.error(
					`[missions] live /team fetch failed { missionId: "${req.params.id}", privateIp: "${mission.privateIp}", error: "${(e as Error).message}" } — falling back to stored config`,
				);
			}
		}
		res.json(
			(mission.agents ?? [])
				.filter((a) => a.active !== false)
				.map((a) => ({ id: a.id, name: a.name ?? a.id })),
		);
	};
}

// Mark operator messages as read (body: { ids: string[] }).
function postMessagesRead({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		const ids = (req.body?.ids as string[] | undefined) ?? [];
		if (ids.length > 0) {
			await storedCollection(db, "mailbox").updateMany(
				{ missionId: req.params.id, to: "user", id: { $in: ids } },
				{ $addToSet: { readBy: "user" } },
			);
		}
		res.json({ ok: true });
	};
}

// Send an operator message to one or more agents (wakes them via the mailbox
// Change Stream, same as cli-post). Body: { to: string | string[], body, subject? }.
function postMessagesSend({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		const rawTo = req.body?.to;
		const to = (Array.isArray(rawTo) ? rawTo : [rawTo]).filter(
			(t): t is string => typeof t === "string" && t.length > 0,
		);
		const body = req.body?.body as string | undefined;
		if (to.length === 0 || !body) {
			res
				.status(400)
				.json({ error: "to (string | string[]) and body are required" });
			return;
		}
		await postMailbox(db, {
			missionId: req.params.id,
			from: "user",
			to,
			subject:
				(req.body?.subject as string | undefined) ?? "Message from operator",
			body,
		});
		res.json({ ok: true });
	};
}

export function registerMissionReadRoutes(
	routes: AsyncRoutes,
	deps: MissionRouteDeps,
): void {
	routes.get("/", listMissions(deps));
	routes.get("/stats", getStats(deps));
	routes.get("/:id", getMission(deps));
	routes.get("/:id/conversations", getConversations(deps));
	routes.get("/:id/agents", getAgents(deps));
	routes.post("/:id/messages/read", postMessagesRead(deps));
	routes.post("/:id/messages/send", postMessagesSend(deps));
}
