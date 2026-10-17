/**
 * GET /api/catalog — what the cockpit's config editors may offer as toggles:
 * the platform skills actually shipped (the `packages/skills/` directory,
 * read once at startup) and the Tier A tool names from the worker's own
 * list. Both used to be hard-coded in the cockpit; seven of thirteen shipped
 * skills could not be disabled from the UI, and the tool list named a tool
 * that had been renamed.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TIER_A_TOOL_NAMES } from "@magi/agent-runtime-worker";
import type { Router } from "express";
import express from "express";

export interface Catalog {
	platformSkills: string[];
	tierATools: string[];
}

export function readCatalog(repoRoot: string): Catalog {
	const dir = join(repoRoot, "packages", "skills");
	let platformSkills: string[] = [];
	try {
		platformSkills = readdirSync(dir)
			.filter((name) => {
				try {
					return statSync(join(dir, name, "SKILL.md")).isFile();
				} catch {
					return false;
				}
			})
			.sort();
	} catch (e) {
		console.error(
			`[catalog] could not list platform skills in ${dir}: ${(e as Error).message} — the cockpit will offer no platform-skill toggles`,
		);
	}
	return { platformSkills, tierATools: [...TIER_A_TOOL_NAMES] };
}

export function createCatalogRouter(repoRoot: string): Router {
	const catalog = readCatalog(repoRoot);
	const router = express.Router();
	router.get("/", (_req, res) => {
		res.json(catalog);
	});
	return router;
}
