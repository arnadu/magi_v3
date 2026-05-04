/**
 * Mission CRUD + lifecycle routes.
 *
 * POST   /api/missions              — provision a new mission
 * GET    /api/missions              — list all missions
 * GET    /api/missions/:id          — get one mission
 * POST   /api/missions/:id/suspend  — stop execution machine
 * POST   /api/missions/:id/resume   — start execution machine
 * DELETE /api/missions/:id          — destroy machine + volume (irreversible)
 */

import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Db } from "mongodb";
import {
	destroyMission,
	getMachineState,
	provisionMission,
	resumeMission,
	suspendMission,
} from "./fly-machines.js";
import { getTemplate, patchMissionId } from "./templates.js";

interface MissionDoc {
	missionId: string;
	name: string;
	teamConfig: string;
	machineId?: string;
	privateIp?: string;
	volumeId?: string;
	status: "provisioning" | "running" | "suspended" | "destroyed" | "error";
	createdAt: Date;
	updatedAt: Date;
}

export function createMissionsRouter(db: Db): Router {
	const router = createRouter();
	const col = db.collection<MissionDoc>("missions");

	// List all missions.
	router.get("/", async (_req, res) => {
		const missions = await col.find({}, { sort: { createdAt: -1 } }).toArray();
		res.json(missions);
	});

	// Get one mission.
	router.get("/:id", async (req, res) => {
		const mission = await col.findOne({ missionId: req.params.id });
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

	// Provision a new mission.
	router.post("/", async (req, res) => {
		const { missionId, name, teamConfig } = req.body as {
			missionId?: string;
			name?: string;
			teamConfig?: string;
		};
		if (!missionId || !name || !teamConfig) {
			res
				.status(400)
				.json({ error: "missionId, name, and teamConfig are required" });
			return;
		}

		const existing = await col.findOne({ missionId });
		if (existing) {
			res.status(409).json({ error: "Mission already exists" });
			return;
		}

		const doc: MissionDoc = {
			missionId,
			name,
			teamConfig,
			status: "provisioning",
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		await col.insertOne(doc);

		try {
			// Look up the template in MongoDB. If found, inject the YAML onto the
			// volume at provision time so team configs are editable without image rebuilds.
			const template = await getTemplate(db, teamConfig);
			const teamConfigYaml = template
				? patchMissionId(template.teamConfigYaml, missionId)
				: undefined;
			if (!template) {
				console.warn(
					`[missions] No template found for "${teamConfig}" — falling back to baked-in image path`,
				);
			}

			const handle = await provisionMission(missionId, teamConfig, {
				teamConfigYaml,
				teamFiles: template?.teamFiles,
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
			await col.updateOne(
				{ missionId },
				{ $set: { status: "error", updatedAt: new Date() } },
			);
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// Suspend.
	router.post("/:id/suspend", async (req, res) => {
		const mission = await col.findOne({ missionId: req.params.id });
		if (!mission?.machineId) {
			res.status(404).json({ error: "Not found or no machine" });
			return;
		}
		try {
			await suspendMission(mission.machineId);
			await col.updateOne(
				{ missionId: req.params.id },
				{ $set: { status: "suspended", updatedAt: new Date() } },
			);
			res.json({ status: "suspended" });
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// Resume.
	router.post("/:id/resume", async (req, res) => {
		const mission = await col.findOne({ missionId: req.params.id });
		if (!mission?.machineId) {
			res.status(404).json({ error: "Not found or no machine" });
			return;
		}
		try {
			await resumeMission(mission.machineId);
			await col.updateOne(
				{ missionId: req.params.id },
				{ $set: { status: "running", updatedAt: new Date() } },
			);
			res.json({ status: "running" });
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// Destroy (irreversible).
	router.delete("/:id", async (req, res) => {
		const mission = await col.findOne({ missionId: req.params.id });
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		if (!mission.machineId || !mission.volumeId) {
			// No Fly resources — just mark destroyed.
			await col.updateOne(
				{ missionId: req.params.id },
				{ $set: { status: "destroyed", updatedAt: new Date() } },
			);
			res.json({ status: "destroyed" });
			return;
		}
		try {
			await destroyMission(mission.machineId, mission.volumeId);
			await col.updateOne(
				{ missionId: req.params.id },
				{ $set: { status: "destroyed", updatedAt: new Date() } },
			);
			res.json({ status: "destroyed" });
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	return router;
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
