/**
 * Mission templates — MongoDB-backed collection seeded from config/teams/ on disk.
 *
 * Templates are the operator-visible set of team configs available for launch.
 * Configs under config/teams/test/ are excluded (dev/CI only).
 *
 * Seeding is idempotent: existing documents are never overwritten by the seed
 * so operator edits made via a future PUT /api/templates/:id are preserved.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parseTeamConfig } from "@magi/agent-config";
import { Router } from "express";
import type { Db } from "mongodb";

export interface TeamFile {
	path: string; // relative to team dir, e.g. "skills/data-factory/SKILL.md"
	content: string; // UTF-8 text
}

export interface MissionTemplate {
	_id: string; // template ID, e.g. "gold-digest"
	name: string; // display name, e.g. "Gold Macro Digest"
	teamConfigYaml: string; // full YAML content
	teamFiles: TeamFile[]; // all files under config/teams/{id}/
	createdAt: Date;
	updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Recursively collect all files under a directory as {path, content} pairs.
 * Paths are relative to rootDir.
 */
function collectFiles(dir: string, rootDir: string): TeamFile[] {
	const results: TeamFile[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return results;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			results.push(...collectFiles(full, rootDir));
		} else {
			try {
				results.push({
					path: relative(rootDir, full),
					content: readFileSync(full, "utf-8"),
				});
			} catch {
				/* skip unreadable files */
			}
		}
	}
	return results;
}

/**
 * Read all *.yaml files from config/teams/ (excluding config/teams/test/) and
 * insert them into the templates collection if they do not already exist.
 * Backfills teamFiles on documents that were seeded before this field existed.
 * Called once at control plane startup.
 */
export async function seedTemplates(db: Db, repoRoot: string): Promise<void> {
	const teamsDir = join(repoRoot, "config", "teams");
	let files: string[];
	try {
		files = readdirSync(teamsDir).filter(
			(f) => f.endsWith(".yaml") && f !== "copilot.yaml",
		);
	} catch (e) {
		console.warn(
			`[templates] Could not read ${teamsDir}: ${(e as Error).message}`,
		);
		return;
	}

	const col = db.collection<MissionTemplate>("templates");

	for (const file of files) {
		const id = basename(file, ".yaml");

		let yaml: string;
		try {
			yaml = readFileSync(join(teamsDir, file), "utf-8");
		} catch (e) {
			console.warn(
				`[templates] Could not read ${file}: ${(e as Error).message}`,
			);
			continue;
		}

		const teamDir = join(teamsDir, id);
		const teamFiles = collectFiles(teamDir, teamDir);

		const existing = await col.findOne({ _id: id });
		if (existing) {
			// Backfill teamFiles if missing (templates seeded before this field existed).
			if (!existing.teamFiles || existing.teamFiles.length === 0) {
				await col.updateOne(
					{ _id: id },
					{ $set: { teamFiles, updatedAt: new Date() } },
				);
				console.log(
					`[templates] Backfilled ${teamFiles.length} files for template: ${id}`,
				);
			}
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
			teamFiles,
			createdAt: now,
			updatedAt: now,
		});
		console.log(
			`[templates] Seeded template: ${id} ("${name}") with ${teamFiles.length} files`,
		);
	}
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createTemplatesRouter(db: Db): Router {
	const router = Router();
	const col = db.collection<MissionTemplate>("templates");

	/** Create a new template. */
	router.post("/", async (req, res) => {
		const { id, name, teamConfigYaml, teamFiles } = req.body as {
			id?: string;
			name?: string;
			teamConfigYaml?: string;
			teamFiles?: Array<{ path: string; content: string }>;
		};
		if (!id || !name || typeof teamConfigYaml !== "string") {
			res
				.status(400)
				.json({ error: "id, name, and teamConfigYaml are required" });
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
		const existing = await col.findOne({ _id: id });
		if (existing) {
			res.status(409).json({ error: "Template already exists" });
			return;
		}
		const now = new Date();
		await col.insertOne({
			_id: id,
			name,
			teamConfigYaml,
			teamFiles: teamFiles ?? [],
			createdAt: now,
			updatedAt: now,
		});
		res.status(201).json({ ok: true, id });
	});

	/** List all templates — returns [{id, name}] sorted by id. */
	router.get("/", async (_req, res) => {
		const templates = await db
			.collection<MissionTemplate>("templates")
			.find({}, { projection: { _id: 1, name: 1 } })
			.sort({ _id: 1 })
			.toArray();
		res.json(templates.map((t) => ({ id: t._id, name: t.name })));
	});

	/** Get full template detail — returns {id, name, teamConfigYaml, teamFiles}. */
	router.get("/:id", async (req, res) => {
		const template = await getTemplate(db, req.params.id);
		if (!template) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		res.json({
			id: template._id,
			name: template.name,
			teamConfigYaml: template.teamConfigYaml,
			teamFiles: template.teamFiles,
		});
	});

	/** Update a template's YAML and files. */
	router.put("/:id", async (req, res) => {
		const { teamConfigYaml, teamFiles } = req.body as {
			teamConfigYaml?: string;
			teamFiles?: Array<{ path: string; content: string }>;
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
		const result = await db.collection<MissionTemplate>("templates").updateOne(
			{ _id: req.params.id },
			{
				$set: {
					teamConfigYaml,
					teamFiles: teamFiles ?? [],
					updatedAt: new Date(),
				},
			},
		);
		if (result.matchedCount === 0) {
			res.status(404).json({ error: "Template not found" });
			return;
		}
		res.json({ ok: true });
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
