/**
 * Mission templates — MongoDB-backed collection seeded from config/teams/ on disk.
 *
 * Templates are the operator-visible set of team configs available for launch.
 * Configs under config/teams/test/ are excluded (dev/CI only).
 *
 * Seeding is idempotent: existing documents are never overwritten by the seed
 * so operator edits made via a future PUT /api/templates/:id are preserved.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Router } from "express";
import type { Db } from "mongodb";

export interface MissionTemplate {
	_id: string; // template ID, e.g. "gold-digest"
	name: string; // display name, e.g. "Gold Macro Digest"
	teamConfigYaml: string; // full YAML content
	createdAt: Date;
	updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Read all *.yaml files from config/teams/ (excluding config/teams/test/)
 * and insert them into the templates collection if they do not already exist.
 * Called once at control plane startup.
 */
export async function seedTemplates(db: Db, repoRoot: string): Promise<void> {
	const teamsDir = join(repoRoot, "config", "teams");
	let files: string[];
	try {
		files = readdirSync(teamsDir).filter((f) => f.endsWith(".yaml"));
	} catch (e) {
		console.warn(
			`[templates] Could not read ${teamsDir}: ${(e as Error).message}`,
		);
		return;
	}

	const col = db.collection<MissionTemplate>("templates");

	for (const file of files) {
		const id = basename(file, ".yaml");
		const existing = await col.findOne({ _id: id });
		if (existing) continue;

		let yaml: string;
		try {
			yaml = readFileSync(join(teamsDir, file), "utf-8");
		} catch (e) {
			console.warn(
				`[templates] Could not read ${file}: ${(e as Error).message}`,
			);
			continue;
		}

		// Extract the display name from the YAML (name: "...") without a full parse.
		const nameMatch = yaml.match(/^\s*name:\s*["']?([^"'\n]+)["']?/m);
		const name = nameMatch ? nameMatch[1].trim() : id;

		const now = new Date();
		await col.insertOne({
			_id: id,
			name,
			teamConfigYaml: yaml,
			createdAt: now,
			updatedAt: now,
		});
		console.log(`[templates] Seeded template: ${id} ("${name}")`);
	}
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createTemplatesRouter(db: Db): Router {
	const router = Router();

	/** List all templates — returns [{id, name}] sorted by id. */
	router.get("/", async (_req, res) => {
		const templates = await db
			.collection<MissionTemplate>("templates")
			.find({}, { projection: { _id: 1, name: 1 } })
			.sort({ _id: 1 })
			.toArray();
		res.json(templates.map((t) => ({ id: t._id, name: t.name })));
	});

	return router;
}

// ---------------------------------------------------------------------------
// Lookup (used by missions.ts at provision time)
// ---------------------------------------------------------------------------

export async function getTemplate(
	db: Db,
	id: string,
): Promise<MissionTemplate | null> {
	return db.collection<MissionTemplate>("templates").findOne({ _id: id });
}

// ---------------------------------------------------------------------------
// YAML patching
// ---------------------------------------------------------------------------

/**
 * Replace the mission.id value in a team config YAML with the actual missionId
 * assigned at provision time. Only patches the `id:` field within the `mission:`
 * block — agent `id:` fields (which are list items) are untouched.
 */
export function patchMissionId(yaml: string, missionId: string): string {
	// Match the mission: block header, then lazily consume indented lines until
	// we find `  id: <value>` and replace only that value.
	return yaml.replace(
		/^(mission:\r?\n(?:[ \t]+[^\n]*\r?\n)*?)([ \t]+id:[ \t]*)\S[^\n]*/m,
		`$1$2${missionId}`,
	);
}
