/**
 * Missions API — Reading and replacing a mission's structured config, and a draft's.
 * Registered by `createMissionsRouter` (missions.ts) in the original order.
 */

import {
	type AgentConfig,
	type Limits,
	parseTeamConfig,
	type TeamConfig,
	validateTeamFiles,
} from "@magi/agent-config";
import {
	assertKnownModels,
	buildMissionCopilotAgentConfig,
	createMongoMissionConfigWriter,
	MISSION_COPILOT_AGENT_ID,
	managedRegionKeys,
} from "@magi/agent-runtime-worker";
import type { RequestHandler } from "express";
import type { Db, ObjectId } from "mongodb";
import type { AsyncRoutes } from "./async-handler.js";
import { configChangedSince } from "./config-version.js";
import { postMailbox } from "./mailbox-writer.js";
import type { MissionRouteDeps } from "./mission-scope.js";
import { userFilter } from "./mission-scope.js";

// Get full config for editing — structured config + live mental maps per agent.
function getConfig({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		if (!mission.mission || !mission.agents) {
			res.status(404).json({ error: "No config stored for this mission" });
			return;
		}

		// Mission copilot's own live mental map lives in the same collection under
		// its reserved id, even though it's never in mission.agents (injected
		// in-memory at daemon startup, ADR-0016) — include it here too so the
		// cockpit's Config panel can show it like any other agent's.
		const mentalMaps: Record<string, string> = {};
		const convCol = db.collection("conversationMessages");
		const agentIds = [
			...mission.agents.map((a) => a.id),
			MISSION_COPILOT_AGENT_ID,
		];
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

		// The copilot's systemPrompt/initialMentalMap aren't stored fields —
		// they're synthesized fresh every session from a fixed platform template
		// + this mission's own name/roster (buildMissionCopilotAgentConfig), so
		// there's nothing to round-trip on save. Computed here purely for
		// read-only display.
		const missionCopilotConfig = buildMissionCopilotAgentConfig({
			mission: mission.mission,
			agents: mission.agents,
			missionCopilotLimits: mission.missionCopilotLimits,
		});

		res.json({
			mission: mission.mission,
			agents: mission.agents,
			missionCopilotLimits: mission.missionCopilotLimits,
			teamFiles: mission.teamFiles ?? [],
			mentalMaps,
			missionCopilot: {
				systemPrompt: missionCopilotConfig.systemPrompt,
				initialMentalMap: missionCopilotConfig.initialMentalMap,
			},
		});
	};
}

/**
 * Validate every proposed mental-map edit BEFORE writing anything — a
 * direct-edit save bypasses addElement/updateElement/removeElement entirely,
 * so nothing else stops it from silently dropping a daemon-managed section
 * (#my-objectives), which is only ever re-synced at the next turn start,
 * never recreated from nothing. Returns each edited agent's latest snapshot
 * so the write can reuse the same document's _id instead of reading it twice.
 */
async function checkMentalMapEdits(
	db: Db,
	missionId: string,
	mentalMaps: Record<string, string> | undefined,
): Promise<
	| { latestByAgent: Map<string, { _id: ObjectId; mentalMapHtml: string }> }
	| { error: string }
> {
	const convCol = db.collection("conversationMessages");
	const latestByAgent = new Map<
		string,
		{ _id: ObjectId; mentalMapHtml: string }
	>();
	for (const [agentId, html] of Object.entries(mentalMaps ?? {})) {
		const latest = await convCol.findOne(
			{ agentId, missionId, mentalMapHtml: { $exists: true } },
			{ sort: { turnNumber: -1, seqInTurn: -1 } },
		);
		if (!latest) continue; // mission never ran; initialMentalMap in the config is sufficient
		latestByAgent.set(agentId, {
			_id: latest._id,
			mentalMapHtml: latest.mentalMapHtml as string,
		});
		const before = managedRegionKeys(latest.mentalMapHtml as string);
		const after = managedRegionKeys(html);
		const missing = [...before].filter((k) => !after.has(k));
		if (missing.length > 0) {
			return {
				error:
					`Saving ${agentId}'s mental map would remove managed section(s): ${missing.join(", ")}. ` +
					"These are synced automatically from their real source (objectives, supervisor notes) — " +
					"restore them (even as an empty placeholder with the same data-managed attribute) rather than deleting them by hand.",
			};
		}
	}
	return { latestByAgent };
}

// Update config (structured + mental maps). Mission must be suspended.
function putConfig({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
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

		const {
			mission: nextMission,
			agents,
			missionCopilotLimits,
			teamFiles,
			mentalMaps,
			expectedUpdatedAt,
		} = req.body as {
			mission?: TeamConfig["mission"];
			agents?: AgentConfig[];
			missionCopilotLimits?: Limits;
			teamFiles?: Array<{ path: string; content: string }>;
			mentalMaps?: Record<string, string>;
			expectedUpdatedAt?: string;
		};
		if (!nextMission || !agents) {
			res.status(400).json({ error: "mission and agents are required" });
			return;
		}
		const conflict = configChangedSince(mission.updatedAt, expectedUpdatedAt);
		if (conflict) {
			res.status(409).json({ error: conflict });
			return;
		}
		let validated: TeamConfig;
		try {
			validated = parseTeamConfig({
				mission: { ...nextMission, id: req.params.id },
				agents,
				missionCopilotLimits,
			});
			assertKnownModels(validated.mission);
		} catch (e) {
			res
				.status(400)
				.json({ error: `Invalid team config: ${(e as Error).message}` });
			return;
		}
		// TF1/CHAIN-A: teamFiles paths are written verbatim to the daemon's
		// filesystem on every boot (team-files-sync.ts) — reject a traversal
		// or absolute path here rather than let it reach Mongo at all.
		try {
			validateTeamFiles(teamFiles ?? []);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
			return;
		}

		const checked = await checkMentalMapEdits(db, req.params.id, mentalMaps);
		if ("error" in checked) {
			res.status(400).json({ error: checked.error });
			return;
		}
		const latestByAgent = checked.latestByAgent;
		const convCol = db.collection("conversationMessages");

		await createMongoMissionConfigWriter(db).write(
			req.params.id,
			{
				mission: validated.mission,
				agents: validated.agents,
				missionCopilotLimits: validated.missionCopilotLimits,
			},
			"user",
		);
		await col.updateOne(
			{ missionId: req.params.id },
			{ $set: { teamFiles: teamFiles ?? [] } },
		);

		// Update live mental maps in conversationMessages — validated above.
		// Notify the target agent (issue #39) — previously silent, so the agent
		// had no way to learn its own memory changed or why between turns.
		for (const [agentId, html] of Object.entries(mentalMaps ?? {})) {
			const latest = latestByAgent.get(agentId);
			if (!latest) continue;
			await convCol.updateOne(
				{ _id: latest._id },
				{ $set: { mentalMapHtml: html } },
			);
			await postMailbox(db, {
				missionId: req.params.id,
				from: "user",
				to: [agentId],
				subject: "Your mental map was edited directly",
				body: "The operator edited your mental map directly while the mission was suspended. Review the current content.",
			});
		}

		res.json({ ok: true });
	};
}

// Save a draft's config — permissive, no parseTeamConfig gate. A draft is allowed to be
// incomplete while it's being built up (e.g. zero agents, an agent mid-edit with an empty
// systemPrompt) — full validation only runs at Launch (POST /:id/launch). Full-replace,
// same shape as PUT /:id/config, but skips the mental-map/managed-region/notify machinery
// entirely: a draft has no conversationMessages history, so none of that applies — its
// initialMentalMap lives directly on the agent object, not in a separate mentalMaps record.
function putDraft({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		if (mission.status !== "draft") {
			res.status(409).json({ error: "Mission is not a draft" });
			return;
		}

		const {
			mission: nextMission,
			agents,
			missionCopilotLimits,
			teamFiles,
		} = req.body as {
			mission?: TeamConfig["mission"];
			agents?: AgentConfig[];
			missionCopilotLimits?: Limits;
			teamFiles?: Array<{ path: string; content: string }>;
		};
		if (!nextMission || !agents) {
			res.status(400).json({ error: "mission and agents are required" });
			return;
		}
		// TF1/CHAIN-A: same reason as PUT /:id/config above — a draft is
		// permissive about everything else, but teamFiles still reaches the
		// daemon's filesystem unvalidated otherwise, on launch.
		try {
			validateTeamFiles(teamFiles ?? []);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
			return;
		}

		await createMongoMissionConfigWriter(db).write(
			req.params.id,
			{
				mission: { ...nextMission, id: req.params.id },
				agents,
				missionCopilotLimits,
			},
			"user",
		);
		await col.updateOne(
			{ missionId: req.params.id },
			{ $set: { teamFiles: teamFiles ?? [] } },
		);

		res.json({ ok: true });
	};
}

export function registerMissionConfigRoutes(
	routes: AsyncRoutes,
	deps: MissionRouteDeps,
): void {
	routes.get("/:id/config", getConfig(deps));
	routes.put("/:id/config", putConfig(deps));
	routes.put("/:id/draft", putDraft(deps));
}
