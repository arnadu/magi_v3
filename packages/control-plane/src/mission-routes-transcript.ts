/**
 * Missions API — The Transcripts tab: turns, one turn's messages, its LLM calls and one call's full record.
 * Registered by `createMissionsRouter` (missions.ts) in the original order.
 */

import type { RequestHandler } from "express";
import type { AsyncRoutes } from "./async-handler.js";
import type { MissionRouteDeps } from "./mission-scope.js";
import { userFilter } from "./mission-scope.js";
import {
	queryLlmCall,
	queryLlmCalls,
	queryTranscript,
	queryTurns,
} from "./transcript-queries.js";

// Turn timeline for one agent (from agentTurnStats).
function getTurns({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		const agent = req.query.agent as string | undefined;
		if (!agent) {
			res.status(400).json({ error: "agent query param required" });
			return;
		}
		res.json(await queryTurns(db, req.params.id, agent));
	};
}

// Detailed transcript for one agent+turn (conversationMessages, including
// Research sub-loop messages tagged with parentToolUseId).
function getTranscript({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		const agent = req.query.agent as string | undefined;
		const turn = Number(req.query.turn);
		if (!agent || Number.isNaN(turn)) {
			res.status(400).json({ error: "agent and turn query params required" });
			return;
		}
		res.json(await queryTranscript(db, req.params.id, agent, turn));
	};
}

// LLM calls for one agent+turn — summaries (the drill-down list).
function getLlmCalls({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		const agent = req.query.agent as string | undefined;
		const turn = Number(req.query.turn);
		if (!agent || Number.isNaN(turn)) {
			res.status(400).json({ error: "agent and turn query params required" });
			return;
		}
		res.json(await queryLlmCalls(db, req.params.id, agent, turn));
	};
}

// One full LLM call (the drill-down detail: exact input + output). `output`
// is absent after the 1-day body retention window (usage/cost are kept 90
// days — see pruneOldLogEntries).
function getLlmCall({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		const agent = req.query.agent as string | undefined;
		const turn = Number(req.query.turn);
		const i = Number(req.query.i);
		if (!agent || Number.isNaN(turn) || Number.isNaN(i)) {
			res
				.status(400)
				.json({ error: "agent, turn and i query params required" });
			return;
		}
		const detail = await queryLlmCall(db, req.params.id, agent, turn, i);
		if (!detail) {
			res.status(404).json({ error: "call not found" });
			return;
		}
		res.json(detail);
	};
}

export function registerMissionTranscriptRoutes(
	routes: AsyncRoutes,
	deps: MissionRouteDeps,
): void {
	routes.get("/:id/turns", getTurns(deps));
	routes.get("/:id/transcript", getTranscript(deps));
	routes.get("/:id/llm-calls", getLlmCalls(deps));
	routes.get("/:id/llm-call", getLlmCall(deps));
}
