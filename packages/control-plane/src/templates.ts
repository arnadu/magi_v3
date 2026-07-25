/**
 * Mission templates — immutable, disk-only (ADR-0021).
 *
 * A template is a named, hand-authored starting point for a mission:
 * `config/teams/{id}.yaml`. Templates are read-only at runtime and never
 * stored in a database. Every `config/teams/*.yaml` file (excluding
 * `copilot.yaml` and anything under `test/`) is parsed exactly once, at
 * control-plane startup, into an in-memory map. Changing a template means
 * editing the file and redeploying — there is no template edit, version, or
 * rollback capability anywhere in the running system (cut deliberately; see
 * ADR-0021's "Templates" section for the full rationale).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parseTeamConfigYaml, type TeamConfig } from "@magi/agent-config";
import { Router } from "express";

export interface TeamFile {
	path: string; // relative to team dir, e.g. "skills/dpo-forms/SKILL.md"
	content: string; // UTF-8 text
}

export interface Template {
	id: string; // e.g. "dpo-team" — the filename stem
	name: string;
	config: TeamConfig;
	teamFiles: TeamFile[];
}

// ---------------------------------------------------------------------------
// In-memory store — populated once at startup by loadTemplates(), read by
// getTemplate()/listTemplates(). A module-level singleton is deliberate here:
// templates are process-lifetime-immutable, single control-plane instance,
// and threading a store object through every call site (missions.ts's mission
// creation, the router below, the copilot's ListTemplates/GetTemplate tools)
// would add indirection with no corresponding benefit at this scale.
// ---------------------------------------------------------------------------

const templates = new Map<string, Template>();

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
 * Parse every config/teams/*.yaml file (excluding copilot.yaml and test/)
 * into the in-memory template store. Called once at control-plane startup.
 * A file that fails to parse is logged and skipped — one bad template must
 * not prevent the control plane from starting.
 */
export function loadTemplates(repoRoot: string): void {
	templates.clear();
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

		let config: TeamConfig;
		try {
			config = parseTeamConfigYaml(yaml);
		} catch (e) {
			console.warn(
				`[templates] Skipping invalid template ${templateId}: ${(e as Error).message}`,
			);
			continue;
		}

		const teamDir = join(teamsDir, templateId);
		const teamFiles = collectFiles(teamDir, teamDir);

		templates.set(templateId, {
			id: templateId,
			name: config.mission.name,
			config,
			teamFiles,
		});
		console.log(
			`[templates] Loaded template: ${templateId} ("${config.mission.name}") with ${teamFiles.length} files`,
		);
	}
}

/** Returns a template by id, or null if none exists. */
export function getTemplate(templateId: string): Template | null {
	return templates.get(templateId) ?? null;
}

/** Every loaded template, `{id, name}` only — for listing. */
export function listTemplates(): Array<{ id: string; name: string }> {
	return [...templates.values()]
		.map((t) => ({ id: t.id, name: t.name }))
		.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Router — read-only: GET / (list), GET /:id (fetch). No create/update/version
// routes — templates are immutable once loaded (see module doc comment).
// ---------------------------------------------------------------------------

export function createTemplatesRouter(): Router {
	const router = Router();

	router.get("/", (_req, res) => {
		res.json(listTemplates());
	});

	router.get("/:id", (req, res) => {
		const template = getTemplate(req.params.id);
		if (!template) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		res.json({
			id: template.id,
			name: template.name,
			config: template.config,
			teamFiles: template.teamFiles,
		});
	});

	return router;
}
