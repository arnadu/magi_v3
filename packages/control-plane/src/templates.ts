/**
 * Mission templates — versioned, MongoDB-backed collection seeded from config/teams/ on disk.
 *
 * Each save creates a new version document. "Latest" is always the highest version number.
 * Missions record which version they launched from for a permanent audit trail.
 *
 * Schema: { _id: ObjectId, templateId, version, name, teamConfigYaml, teamFiles, createdAt, createdBy }
 * Unique index: { templateId, version }
 *
 * Configs under config/teams/test/ are excluded (dev/CI only).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parseTeamConfig } from "@magi/agent-config";
import { Router } from "express";
import type { Db, ObjectId } from "mongodb";

export interface TeamFile {
	path: string; // relative to team dir, e.g. "skills/dpo-forms/SKILL.md"
	content: string; // UTF-8 text
}

export interface MissionTemplate {
	_id: ObjectId;
	templateId: string; // e.g. "dpo-team"
	version: number; // 1, 2, 3… monotonically increasing per templateId
	name: string; // display name
	teamConfigYaml: string;
	teamFiles: TeamFile[];
	createdAt: Date;
	createdBy: string; // userId, or "seed" for disk-seeded versions
}

// ---------------------------------------------------------------------------
// Internal helpers
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

/** Return the next version number for a templateId (1 if no versions exist). */
export async function getNextTemplateVersion(
	db: Db,
	templateId: string,
): Promise<number> {
	const latest = await db
		.collection<MissionTemplate>("templates")
		.findOne(
			{ templateId },
			{ sort: { version: -1 }, projection: { version: 1 } },
		);
	return (latest?.version ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Read all *.yaml files from config/teams/ (excluding test/) and insert a v1
 * document for each that has no versions yet. Existing operator-edited templates
 * are never touched — seeding only initialises missing ones.
 * Called once at control plane startup.
 */
export async function seedTemplates(db: Db, repoRoot: string): Promise<void> {
	const col = db.collection<MissionTemplate>("templates");
	// Ensure the compound unique index exists.
	await col.createIndex({ templateId: 1, version: 1 }, { unique: true });

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

	for (const file of files) {
		const templateId = basename(file, ".yaml");
		// Skip test configs.
		if (templateId.startsWith("test/") || file.includes("/test/")) continue;

		let yaml: string;
		try {
			yaml = readFileSync(join(teamsDir, file), "utf-8");
		} catch (e) {
			console.warn(
				`[templates] Could not read ${file}: ${(e as Error).message}`,
			);
			continue;
		}

		const existing = await col.findOne({ templateId });
		if (existing) continue; // operator has versions already — never overwrite

		const teamDir = join(teamsDir, templateId);
		const teamFiles = collectFiles(teamDir, teamDir);

		const nameMatch = yaml.match(/^\s*name:\s*["']?([^"'\n]+)["']?/m);
		const name = nameMatch ? nameMatch[1].trim() : templateId;

		await col.insertOne({
			templateId,
			version: 1,
			name,
			teamConfigYaml: yaml,
			teamFiles,
			createdAt: new Date(),
			createdBy: "seed",
		} as unknown as MissionTemplate);
		console.log(
			`[templates] Seeded template: ${templateId} ("${name}") v1 with ${teamFiles.length} files`,
		);
	}
}

// ---------------------------------------------------------------------------
// Lookup (used by missions.ts at provision time)
// ---------------------------------------------------------------------------

/**
 * Returns the latest version of a template, or null if none exists.
 */
export async function getTemplate(
	db: Db,
	templateId: string,
): Promise<MissionTemplate | null> {
	return db
		.collection<MissionTemplate>("templates")
		.findOne({ templateId }, { sort: { version: -1 } });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createTemplatesRouter(db: Db): Router {
	const router = Router();
	const col = db.collection<MissionTemplate>("templates");

	/** List all templates — one row per templateId at the latest version. */
	router.get("/", async (_req, res) => {
		const latest = await col
			.aggregate<{ _id: string; name: string; version: number }>([
				{ $sort: { version: -1 } },
				{
					$group: {
						_id: "$templateId",
						name: { $first: "$name" },
						version: { $first: "$version" },
					},
				},
				{ $sort: { _id: 1 } },
			])
			.toArray();
		res.json(
			latest.map((t) => ({ id: t._id, name: t.name, version: t.version })),
		);
	});

	/** Get the latest version of a template. */
	router.get("/:id", async (req, res) => {
		const template = await getTemplate(db, req.params.id);
		if (!template) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		res.json({
			id: template.templateId,
			version: template.version,
			name: template.name,
			teamConfigYaml: template.teamConfigYaml,
			teamFiles: template.teamFiles,
		});
	});

	/** Create a template (v1). Fails if any version already exists for this templateId. */
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
		const existing = await col.findOne({ templateId: id });
		if (existing) {
			res.status(409).json({ error: "Template already exists" });
			return;
		}
		await col.insertOne({
			templateId: id,
			version: 1,
			name,
			teamConfigYaml,
			teamFiles: teamFiles ?? [],
			createdAt: new Date(),
			createdBy: (req as { userId?: string }).userId ?? "api",
		} as unknown as MissionTemplate);
		res.status(201).json({ ok: true, id, version: 1 });
	});

	/** Update a template — inserts a new version, preserves history. */
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
		const latest = await getTemplate(db, req.params.id);
		if (!latest) {
			res.status(404).json({ error: "Template not found" });
			return;
		}
		const nextVersion = latest.version + 1;
		await col.insertOne({
			templateId: req.params.id,
			version: nextVersion,
			name: latest.name,
			teamConfigYaml,
			teamFiles: teamFiles ?? latest.teamFiles,
			createdAt: new Date(),
			createdBy: (req as { userId?: string }).userId ?? "api",
		} as unknown as MissionTemplate);
		res.json({ ok: true, version: nextVersion });
	});

	return router;
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
	return yaml.replace(
		/^(mission:\r?\n(?:[ \t]+[^\n]*\r?\n)*?)([ \t]+id:[ \t]*)\S[^\n]*/m,
		`$1$2${missionId}`,
	);
}
