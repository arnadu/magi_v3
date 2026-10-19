/**
 * Platform-wide read routes: per-user LLM usage and the model catalog for
 * the model pickers. Mounted behind requireAuth.
 */

import { storedCollection } from "@magi/agent-config";
import {
	CLAUDE_HAIKU,
	CLAUDE_OPUS,
	CLAUDE_SONNET,
	fetchOpenRouterCatalog,
	type OpenRouterModelInfo,
} from "@magi/agent-runtime-worker";
import { Router as createRouter, type Router } from "express";
import type { Db } from "mongodb";
import { asyncRoutes } from "./async-handler.js";
import { lifetimeCostByMission } from "./usage-queries.js";

// Model catalog for the model picker (mission/agent config editor + copilot
// settings) — first-party Anthropic (hardcoded: no public unauthenticated
// discovery endpoint) + OpenRouter's live catalog (cached process-wide by
// fetchOpenRouterCatalog itself, so this route is cheap after the first call).
export const ANTHROPIC_MODELS: OpenRouterModelInfo[] = [
	{
		id: CLAUDE_OPUS.id,
		name: "Claude Opus 4.8",
		contextLength: CLAUDE_OPUS.contextWindow,
		supportsVision: true,
		pricing: {
			input: CLAUDE_OPUS.cost.input,
			output: CLAUDE_OPUS.cost.output,
			cacheRead: CLAUDE_OPUS.cost.cacheRead,
			cacheWrite: CLAUDE_OPUS.cost.cacheWrite,
		},
	},
	{
		id: CLAUDE_SONNET.id,
		name: "Claude Sonnet 4.6",
		contextLength: CLAUDE_SONNET.contextWindow,
		supportsVision: true,
		pricing: {
			input: CLAUDE_SONNET.cost.input,
			output: CLAUDE_SONNET.cost.output,
			cacheRead: CLAUDE_SONNET.cost.cacheRead,
			cacheWrite: CLAUDE_SONNET.cost.cacheWrite,
		},
	},
	{
		id: CLAUDE_HAIKU.id,
		name: "Claude Haiku 4.5",
		contextLength: CLAUDE_HAIKU.contextWindow,
		supportsVision: true,
		pricing: {
			input: CLAUDE_HAIKU.cost.input,
			output: CLAUDE_HAIKU.cost.output,
			cacheRead: CLAUDE_HAIKU.cost.cacheRead,
			cacheWrite: CLAUDE_HAIKU.cost.cacheWrite,
		},
	},
];

export function createPlatformRoutes(db: Db): Router {
	const router = createRouter();
	const appRoutes = asyncRoutes(router);
	// Per-user LLM usage summary (admin sees all missions).
	appRoutes.get("/api/usage", async (req, res) => {
		const filter = req.isAdmin ? {} : { userId: req.userId };
		const missions = await storedCollection(db, "missions")
			.find(filter, {
				projection: { missionId: 1, name: 1, userId: 1, _id: 0 },
			})
			.toArray();
		const missionIds = missions.map((m) => m.missionId as string);
		const costs = await lifetimeCostByMission(db, missionIds);
		res.json(
			missions.map((m) => ({
				...m,
				usage: costs.get(m.missionId as string) ?? {
					totalCostUsd: 0,
					calls: 0,
				},
			})),
		);
	});

	appRoutes.get("/api/models", async (_req, res) => {
		const openrouter = await fetchOpenRouterCatalog();
		res.json({ anthropic: ANTHROPIC_MODELS, openrouter });
	});
	return router;
}
