/**
 * Mission CRUD + lifecycle routes.
 *
 * POST   /api/missions              — provision a new mission
 * GET    /api/missions              — list all missions
 * GET    /api/missions/:id          — get one mission
 * GET    /api/missions/:id/config   — get full YAML config + live mental maps
 * PUT    /api/missions/:id/config   — update YAML config + mental maps (suspended only)
 * POST   /api/missions/:id/suspend  — stop execution machine
 * POST   /api/missions/:id/resume   — start execution machine (injects updated YAML)
 * DELETE /api/missions/:id          — destroy machine + volume (irreversible)
 */

import { parseTeamConfig } from "@magi/agent-config";
import type { Request, Router } from "express";
import { Router as createRouter } from "express";
import type { Db } from "mongodb";
import {
	deleteMachine,
	destroyLocal,
	destroyMission,
	getMachineState,
	isLocalExecution,
	provisionLocal,
	provisionMission,
	suspendMission,
	updateLocalMissionConfig,
} from "./fly-machines.js";
import { getTemplate, patchMissionId } from "./templates.js";

interface MissionDoc {
	missionId: string;
	/** Firebase UID of the owner, or "admin" for CONTROL_API_KEY-created missions. */
	userId: string;
	name: string;
	teamConfig: string;
	/** Full YAML stored at provision time; updated on config edit. */
	teamConfigYaml?: string;
	/** Team files (skills, etc.) stored at provision time; updated on config edit. */
	teamFiles?: Array<{ path: string; content: string }>;
	/** Template version used when the mission was launched (audit trail). */
	templateVersion?: number;
	machineId?: string;
	privateIp?: string;
	volumeId?: string;
	status: "provisioning" | "running" | "suspended" | "destroyed" | "error";
	/** Set when status === "error"; cleared on successful resume. */
	errorMessage?: string;
	createdAt: Date;
	updatedAt: Date;
}

/** Admin sees all missions; regular users see only their own. */
function userFilter(req: Request): Partial<MissionDoc> {
	return req.isAdmin ? {} : { userId: req.userId };
}

export function createMissionsRouter(db: Db): Router {
	const router = createRouter();
	const col = db.collection<MissionDoc>("missions");

	// Create userId index on first router mount (idempotent).
	void col.createIndex({ userId: 1, createdAt: -1 });

	// List missions (scoped to current user unless admin).
	router.get("/", async (req, res) => {
		const missions = await col
			.find(userFilter(req), { sort: { createdAt: -1 } })
			.toArray();
		res.json(missions);
	});

	// Per-mission telemetry — registered before /:id to avoid route shadowing.
	router.get("/stats", async (req, res) => {
		const missions = await col
			.find(
				{ ...userFilter(req), status: { $ne: "destroyed" } },
				{ projection: { missionId: 1, _id: 0 } },
			)
			.toArray();
		const missionIds = missions.map((m) => m.missionId);

		const now = new Date();
		const oneHourAgo = new Date(now.getTime() - 3_600_000);
		const todayStart = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate(),
		);

		const [unreadCounts, spendDocs, lastActivityDocs] = await Promise.all([
			db
				.collection("mailbox")
				.aggregate([
					{ $match: { missionId: { $in: missionIds }, read: false } },
					{ $group: { _id: "$missionId", count: { $sum: 1 } } },
				])
				.toArray(),
			db
				.collection("llmCallLog")
				.aggregate([
					{ $match: { missionId: { $in: missionIds } } },
					{
						$group: {
							_id: "$missionId",
							total: { $sum: "$cost" },
							today: {
								$sum: {
									$cond: [{ $gte: ["$createdAt", todayStart] }, "$cost", 0],
								},
							},
							lastHour: {
								$sum: {
									$cond: [{ $gte: ["$createdAt", oneHourAgo] }, "$cost", 0],
								},
							},
						},
					},
				])
				.toArray(),
			db
				.collection("conversationMessages")
				.aggregate([
					{ $match: { missionId: { $in: missionIds } } },
					{ $sort: { createdAt: -1 } },
					{
						$group: {
							_id: "$missionId",
							lastActivity: { $first: "$createdAt" },
							snippet: { $first: "$content" },
						},
					},
				])
				.toArray(),
		]);

		const stats: Record<string, object> = {};
		for (const id of missionIds) {
			const u = unreadCounts.find((d) => d._id === id);
			const s = spendDocs.find((d) => d._id === id);
			const a = lastActivityDocs.find((d) => d._id === id);
			stats[id] = {
				unread: u?.count ?? 0,
				spendTotal: s?.total ?? 0,
				spendToday: s?.today ?? 0,
				spendLastHour: s?.lastHour ?? 0,
				lastActivity: a?.lastActivity ?? null,
				snippet:
					typeof a?.snippet === "string" ? a.snippet.slice(0, 120) : null,
			};
		}
		res.json(stats);
	});

	// Get one mission.
	router.get("/:id", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		// Refresh live machine state from Fly.
		if (mission.machineId && mission.status !== "destroyed") {
			try {
				const liveState = await getMachineState(mission.machineId);
				const mapped = liveStateToStatus(liveState);
				if (mapped !== mission.status) {
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
	});

	// Get full config for editing — YAML + live mental maps per agent.
	router.get("/:id/config", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		if (!mission.teamConfigYaml) {
			res.status(404).json({ error: "No config stored for this mission" });
			return;
		}

		// Extract agent IDs from YAML to look up live mental maps.
		const agentIds = extractAgentIds(mission.teamConfigYaml);
		const mentalMaps: Record<string, string> = {};
		const convCol = db.collection("conversationMessages");
		for (const agentId of agentIds) {
			const doc = await convCol.findOne(
				{
					agentId,
					missionId: mission.missionId,
					mentalMapHtml: { $exists: true },
				},
				{ sort: { turnNumber: -1, seqInTurn: -1 } },
			);
			if (doc?.mentalMapHtml) {
				mentalMaps[agentId] = doc.mentalMapHtml as string;
			}
		}

		res.json({
			teamConfigYaml: mission.teamConfigYaml,
			teamFiles: mission.teamFiles ?? [],
			mentalMaps,
		});
	});

	// Update config (YAML + mental maps). Mission must be suspended.
	router.put("/:id/config", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		if (mission.status !== "suspended") {
			res
				.status(409)
				.json({ error: "Mission must be suspended before editing config" });
			return;
		}

		const { teamConfigYaml, teamFiles, mentalMaps } = req.body as {
			teamConfigYaml?: string;
			teamFiles?: Array<{ path: string; content: string }>;
			mentalMaps?: Record<string, string>;
		};
		if (typeof teamConfigYaml !== "string") {
			res.status(400).json({ error: "teamConfigYaml is required" });
			return;
		}
		try {
			parseTeamConfig(teamConfigYaml);
		} catch (e) {
			res
				.status(400)
				.json({ error: `Invalid team config: ${(e as Error).message}` });
			return;
		}

		await col.updateOne(
			{ missionId: req.params.id },
			{
				$set: {
					teamConfigYaml,
					teamFiles: teamFiles ?? [],
					updatedAt: new Date(),
				},
			},
		);

		// Update live mental maps in conversationMessages if provided.
		if (mentalMaps && Object.keys(mentalMaps).length > 0) {
			const convCol = db.collection("conversationMessages");
			for (const [agentId, html] of Object.entries(mentalMaps)) {
				const latest = await convCol.findOne(
					{
						agentId,
						missionId: req.params.id,
						mentalMapHtml: { $exists: true },
					},
					{ sort: { turnNumber: -1, seqInTurn: -1 } },
				);
				if (latest) {
					await convCol.updateOne(
						{ _id: latest._id },
						{ $set: { mentalMapHtml: html } },
					);
				}
				// If no record found: mission never ran; initialMentalMap in the YAML is sufficient.
			}
		}

		res.json({ ok: true });
	});

	// Provision a new mission.
	router.post("/", async (req, res) => {
		const {
			missionId,
			name,
			teamConfig,
			teamConfigYaml: inlineYaml,
			teamFiles: inlineFiles,
		} = req.body as {
			missionId?: string;
			name?: string;
			teamConfig?: string;
			teamConfigYaml?: string;
			teamFiles?: Array<{ path: string; content: string }>;
		};
		if (!missionId || !name || !teamConfig) {
			res
				.status(400)
				.json({ error: "missionId, name, and teamConfig are required" });
			return;
		}

		// Validate inline YAML before inserting the record so a bad payload
		// never leaves a stuck "provisioning" document.
		if (inlineYaml) {
			try {
				parseTeamConfig(inlineYaml);
			} catch (e) {
				res
					.status(400)
					.json({ error: `Invalid teamConfigYaml: ${(e as Error).message}` });
				return;
			}
		}

		const existing = await col.findOne({ missionId });
		if (existing) {
			res.status(409).json({ error: "Mission already exists" });
			return;
		}

		// Resolve YAML + teamFiles BEFORE inserting the mission doc so the daemon
		// can fetch teamFiles from MongoDB at startup instead of reading a large
		// TEAM_FILES_PAYLOAD env var (which would exceed Fly's machine config limit
		// for team configs with many skill files).
		let resolvedYaml: string | undefined;
		let resolvedFiles: Array<{ path: string; content: string }> = [];
		let resolvedTemplateVersion: number | undefined;

		if (inlineYaml) {
			resolvedYaml = patchMissionId(inlineYaml, missionId);
			resolvedFiles = inlineFiles ?? [];
		} else {
			const template = await getTemplate(db, teamConfig);
			if (template) {
				resolvedYaml = patchMissionId(template.teamConfigYaml, missionId);
				resolvedFiles = template.teamFiles ?? [];
				resolvedTemplateVersion = template.version;
			} else {
				console.warn(
					`[missions] No template found for "${teamConfig}" — falling back to baked-in image path`,
				);
			}
		}

		const doc: MissionDoc = {
			missionId,
			userId: req.userId,
			name,
			teamConfig,
			teamConfigYaml: resolvedYaml,
			teamFiles: resolvedFiles,
			templateVersion: resolvedTemplateVersion,
			status: "provisioning",
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		await col.insertOne(doc);

		try {
			// Cloud: omit teamFiles from the machine env — daemon fetches from MongoDB.
			// Local: write to disk since the developer's daemon reads from the local path.
			const handle = isLocalExecution()
				? provisionLocal(missionId, {
						teamConfigYaml: resolvedYaml,
						teamFiles: resolvedFiles,
					})
				: await provisionMission(missionId, teamConfig, {
						teamConfigYaml: resolvedYaml,
					});
			await col.updateOne(
				{ missionId },
				{
					$set: {
						machineId: handle.machineId,
						privateIp: handle.privateIp,
						volumeId: handle.volumeId,
						status: "running",
						updatedAt: new Date(),
					},
				},
			);
			res.status(201).json({ ...doc, ...handle, status: "running" });
		} catch (e) {
			const errorMessage = (e as Error).message;
			console.error(
				`[missions] provision failed { missionId: "${missionId}", error: "${errorMessage}" }`,
			);
			await col.updateOne(
				{ missionId },
				{ $set: { status: "error", errorMessage, updatedAt: new Date() } },
			);
			res.status(500).json({ error: errorMessage });
		}
	});

	// Suspend.
	router.post("/:id/suspend", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission?.machineId) {
			res.status(404).json({ error: "Not found or no machine" });
			return;
		}
		try {
			if (!mission.machineId.startsWith("local-")) {
				await suspendMission(mission.machineId);
			}
			await col.updateOne(
				{ missionId: req.params.id },
				{ $set: { status: "suspended", updatedAt: new Date() } },
			);
			res.json({ status: "suspended" });
		} catch (e) {
			console.error(
				`[missions] suspend failed { missionId: "${req.params.id}", error: "${(e as Error).message}" }`,
			);
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// Resume — push latest YAML to machine env before starting.
	router.post("/:id/resume", async (req, res) => {
		const missionId = req.params.id;
		const mission = await col.findOne({
			missionId,
			...userFilter(req),
		});
		if (!mission?.machineId) {
			res.status(404).json({ error: "Not found or no machine" });
			return;
		}
		try {
			if (mission.machineId.startsWith("local-")) {
				// Re-write config files so the developer can restart the daemon.
				if (mission.teamConfigYaml) {
					updateLocalMissionConfig(
						missionId,
						mission.teamConfigYaml,
						mission.teamFiles ?? [],
					);
				}
			} else {
				// Resume on Fly: delete the stopped machine and provision a fresh one
				// against the preserved workspace volume. This guarantees the new machine
				// boots with the current config from MongoDB — the Fly PATCH API for
				// env-var updates on stopped machines is unreliable.
				if (!mission.volumeId) {
					throw new Error(
						"No volume ID stored for this mission — cannot resume",
					);
				}
				// Best-effort delete of the old machine. If it's already gone (deleted
				// outside MAGI), skip and proceed to provision.
				try {
					await deleteMachine(mission.machineId);
					console.log(
						`[missions] deleted old machine ${mission.machineId} before re-provision`,
					);
				} catch (e) {
					console.warn(
						`[missions] could not delete machine ${mission.machineId}: ${(e as Error).message} — proceeding to provision anyway`,
					);
				}
				const handle = await provisionMission(missionId, mission.teamConfig, {
					existingVolumeId: mission.volumeId,
					teamConfigYaml: mission.teamConfigYaml,
					// teamFiles omitted: daemon fetches from missions collection at startup
				});
				await col.updateOne(
					{ missionId },
					{
						$set: {
							machineId: handle.machineId,
							privateIp: handle.privateIp,
							status: "running",
							updatedAt: new Date(),
						},
					},
				);
				res.json({ status: "running" });
				return;
			}
			await col.updateOne(
				{ missionId },
				{ $set: { status: "running", updatedAt: new Date() } },
			);
			res.json({ status: "running" });
		} catch (e) {
			console.error(
				`[missions] resume failed { missionId: "${missionId}", error: "${(e as Error).message}" }`,
			);
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// Destroy (irreversible).
	router.delete("/:id", async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		try {
			if (mission.machineId?.startsWith("local-")) {
				destroyLocal(req.params.id);
			} else if (mission.machineId && mission.volumeId) {
				await destroyMission(mission.machineId, mission.volumeId);
			}
			await col.updateOne(
				{ missionId: req.params.id },
				{ $set: { status: "destroyed", updatedAt: new Date() } },
			);
			res.json({ status: "destroyed" });
		} catch (e) {
			console.error(
				`[missions] destroy failed { missionId: "${req.params.id}", error: "${(e as Error).message}" }`,
			);
			res.status(500).json({ error: (e as Error).message });
		}
	});

	return router;
}

/** Extract all agent IDs from a team YAML using the `  - id:` sequence item pattern. */
function extractAgentIds(yaml: string): string[] {
	const ids: string[] = [];
	for (const m of yaml.matchAll(/^ {2}- id:\s*(\S+)/gm)) {
		ids.push(m[1]);
	}
	return ids;
}

function liveStateToStatus(flyState: string): MissionDoc["status"] {
	switch (flyState) {
		case "started":
		case "starting":
			return "running";
		case "stopped":
		case "stopping":
			return "suspended";
		case "destroyed":
		case "destroying":
			return "destroyed";
		default:
			return "error";
	}
}
