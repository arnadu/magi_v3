/**
 * LLM-facing text is code (audit RC: SCHED2, OV1, TPL4, MAF1 — prompts that
 * named scripts, tools and protocols that did not exist). Two contracts:
 *
 * 1. Every skill script a skill, template or prompt tells an agent to run
 *    exists where the reference says.
 * 2. Retired tool, script and protocol names appear nowhere an agent or the
 *    spec would read them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");

function* files(dir: string, ext: RegExp): Generator<string> {
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist" || name === "__pycache__")
			continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) yield* files(p, ext);
		else if (ext.test(name)) yield p;
	}
}

/** What agents and the copilots read: skills, templates, and the platform prompts. */
const LLM_TEXT = [
	...files(join(ROOT, "packages", "skills"), /\.(md|sh|py|json)$/),
	...files(join(ROOT, "config", "teams"), /\.(md|ya?ml|json)$/),
	...files(join(ROOT, "packages", "agent-runtime-worker", "prompts"), /./),
	join(ROOT, "MAGI_V3_SPEC.md"),
];

const teamSkillDirs = [...readdirSync(join(ROOT, "config", "teams"))]
	.map((t) => join(ROOT, "config", "teams", t, "skills"))
	.filter((d) => existsSync(d));

function scriptExists(tier: "platform" | "team", skill: string, file: string) {
	if (tier === "platform") {
		return existsSync(join(ROOT, "packages", "skills", skill, "scripts", file));
	}
	return teamSkillDirs.some((d) => existsSync(join(d, skill, "scripts", file)));
}

describe("LLM-facing text references", () => {
	it("every referenced skill script exists", () => {
		const missing: string[] = [];
		const patterns: Array<[RegExp, "platform" | "team"]> = [
			[
				/skills\/_platform\/([a-z0-9-]+)\/scripts\/([A-Za-z0-9_.-]+\.(?:sh|py))/g,
				"platform",
			],
			[
				/skills\/_team\/([a-z0-9-]+)\/scripts\/([A-Za-z0-9_.-]+\.(?:sh|py))/g,
				"team",
			],
			[
				/\$SKILL_DIR\/\.\.\/([a-z0-9-]+)\/scripts\/([A-Za-z0-9_.-]+\.(?:sh|py))/g,
				"platform",
			],
			[
				/<platform-skills-path>\/([a-z0-9-]+)\/scripts\/([A-Za-z0-9_.-]+\.(?:sh|py))/g,
				"platform",
			],
		];
		for (const file of LLM_TEXT) {
			const text = readFileSync(file, "utf8");
			for (const [re, tier] of patterns) {
				for (const m of text.matchAll(re)) {
					if (!scriptExists(tier, m[1], m[2])) {
						missing.push(
							`${relative(ROOT, file)} → ${tier}/${m[1]}/scripts/${m[2]}`,
						);
					}
				}
			}
		}
		expect(missing).toEqual([]);
	});

	it("names no retired tool, script or protocol", () => {
		const RETIRED: Array<[RegExp, string]> = [
			[/\bUpdateMentalMap\b/, "renamed to mental_map_update/add/remove"],
			[/\bPublishArtifact\b/, "never existed; deliverables are shared files"],
			[
				/\btask-update\.sh\b|\brecord-kpi\.sh\b/,
				"deleted in ADR-0019; use UpdateTask/RecordKpi",
			],
			[/\brefresh\.sh\b/, "never existed; refresh.py runs as a background job"],
			[
				/[Cc]ommit (?:\w+ ){0,3}via git-provenance/,
				"the daemon commits at turn end",
			],
			[
				/keys are injected|injected by the daemon/i,
				"no key reaches a job (CR-04)",
			],
		];
		const hits: string[] = [];
		for (const file of LLM_TEXT) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, i) => {
				for (const [re, why] of RETIRED) {
					if (re.test(line))
						hits.push(`${relative(ROOT, file)}:${i + 1} (${why})`);
				}
			});
		}
		expect(hits).toEqual([]);
	});
});
