/**
 * LLM-facing text is code: every ProposeAction example in the control-plane
 * copilot's skills must parse against the action registry. A skill that
 * documents a wrong key (SCHED3's `cronExpression`, SCFG1's `teamConfigYaml`)
 * or an action that does not exist (`save_template`) fails here, not in a
 * live session.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionPayload } from "../src/copilot-actions.js";

const SKILLS_DIR = join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"config",
	"teams",
	"copilot",
	"skills",
);

function skillFiles(): string[] {
	return readdirSync(SKILLS_DIR)
		.map((d) => join(SKILLS_DIR, d, "SKILL.md"))
		.filter((p) => {
			try {
				return statSync(p).isFile();
			} catch {
				return false;
			}
		});
}

/** Every ```json block that looks like a ProposeAction call: `{ "type": "...", "payload": {...} }`. */
function proposeExamples(
	md: string,
): Array<{ type: string; payload: unknown; snippet: string }> {
	const out: Array<{ type: string; payload: unknown; snippet: string }> = [];
	for (const m of md.matchAll(/```json\n([\s\S]*?)```/g)) {
		const snippet = m[1].trim();
		if (!/"type"\s*:/.test(snippet) || !/"payload"\s*:/.test(snippet)) continue;
		let parsed: { type?: string; payload?: unknown };
		try {
			parsed = JSON.parse(snippet);
		} catch {
			throw new Error(
				`Unparseable JSON example in a copilot skill:\n${snippet}`,
			);
		}
		if (typeof parsed.type === "string") {
			out.push({ type: parsed.type, payload: parsed.payload, snippet });
		}
	}
	return out;
}

describe("copilot skills: ProposeAction examples match the registry", () => {
	const files = skillFiles();
	it("finds skills to check", () => {
		expect(files.length).toBeGreaterThan(5);
	});
	for (const file of files) {
		const examples = proposeExamples(readFileSync(file, "utf8"));
		for (const ex of examples) {
			it(`${file.split("/").slice(-2, -1)[0]}: ${ex.type} example parses`, () => {
				expect(
					() => parseActionPayload(ex.type, ex.payload),
					ex.snippet,
				).not.toThrow();
			});
		}
	}
});
