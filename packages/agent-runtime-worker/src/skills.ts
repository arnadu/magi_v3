import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkillScope = "platform" | "team" | "mission" | "agent";

export interface SkillMetadata {
	name: string;
	description: string;
	scope: SkillScope;
}

export interface SkillsBlock {
	/** Absolute path to the platform skill tier (read-only for agents). */
	platformPath: string;
	/** Absolute path to the mission skill tier (shared writable for agents). */
	missionPath: string;
	/** Absolute path to the agent-local skill tier (private writable). */
	agentPath: string;
	/** All discovered skills, higher-scope entry wins on name collision. */
	skills: SkillMetadata[];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scan the four skill tiers and return the merged skill list plus the three
 * actionable paths agents need to read skills and create new ones.
 *
 * Scanning order: platform → team → mission → agent-local.
 * A skill at a higher tier overwrites a same-named skill at a lower tier.
 */
export function discoverSkills(
	sharedDir: string,
	workdir: string,
): SkillsBlock {
	const platformPath = join(sharedDir, "skills", "_platform");
	const teamPath = join(sharedDir, "skills", "_team");
	const missionPath = join(sharedDir, "skills", "mission");
	const agentPath = join(workdir, "skills");

	const map = new Map<string, SkillMetadata>();

	scanTier(platformPath, "platform", map);
	scanTier(teamPath, "team", map);
	scanTier(missionPath, "mission", map);
	scanTier(agentPath, "agent", map);

	return {
		platformPath,
		missionPath,
		agentPath,
		skills: Array.from(map.values()),
	};
}

function scanTier(
	tierPath: string,
	scope: SkillScope,
	map: Map<string, SkillMetadata>,
): void {
	if (!existsSync(tierPath)) return;

	let entries: string[];
	try {
		// withFileTypes: filter to real directories only — prevents symlink injection
		// (an agent with write access to mission/ could otherwise symlink arbitrary dirs).
		entries = readdirSync(tierPath, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return;
	}

	for (const entry of entries) {
		const skillMdPath = join(tierPath, entry, "SKILL.md");
		if (!existsSync(skillMdPath)) continue;

		let content: string;
		try {
			content = readFileSync(skillMdPath, "utf-8");
		} catch {
			continue;
		}

		const meta = parseFrontmatter(content);
		if (!meta) continue;

		map.set(meta.name, { ...meta, scope });
	}
}

/**
 * Parse the YAML frontmatter block (between the first pair of `---` markers).
 * Returns null if the frontmatter is absent, malformed, or missing required fields.
 * Description is trimmed to its first non-empty line for compact display.
 */
function parseFrontmatter(
	content: string,
): { name: string; description: string } | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return null;

	let fm: unknown;
	try {
		fm = parse(match[1]);
	} catch {
		return null;
	}

	if (
		typeof fm !== "object" ||
		fm === null ||
		typeof (fm as Record<string, unknown>).name !== "string" ||
		typeof (fm as Record<string, unknown>).description !== "string"
	) {
		return null;
	}

	const name = ((fm as Record<string, unknown>).name as string).trim();
	const rawDescription = (fm as Record<string, unknown>).description as string;

	// First non-empty line of the (possibly multi-line) description.
	const description =
		rawDescription
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0) ?? "";

	if (!name || !description) return null;
	return { name, description };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format the skills block for injection into an agent's system prompt.
 *
 * Shows three explicit absolute paths so the agent knows exactly where to
 * read SKILL.md files and where to write new skills, without guessing.
 */
export function formatSkillsBlock(block: SkillsBlock): string {
	const lines: string[] = [
		"## Available Skills",
		`Platform skills (read-only): ${block.platformPath}`,
		`Mission skills (shared):      ${block.missionPath}`,
		`Your private skills:          ${block.agentPath}`,
		"",
		"Read SKILL.md and run scripts/ via Bash when relevant.",
		"To add a skill for the whole team this mission, write it under the mission path.",
		"To add a skill for yourself only, write it under your private path.",
	];

	if (block.skills.length > 0) {
		lines.push("");
		for (const skill of block.skills) {
			lines.push(`- ${skill.name} [${skill.scope}]: ${skill.description}`);
		}
	}

	return lines.join("\n");
}
