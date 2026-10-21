/**
 * Contract: the docs point at things that exist. Every relative link in a
 * tracked Markdown file resolves, and every `npm run <script>` the operator
 * docs mention is a real script in some package.json.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");

const trackedMarkdown = execFileSync("git", ["ls-files", "*.md"], {
	cwd: ROOT,
	encoding: "utf8",
})
	.split("\n")
	.filter((f) => f && !f.startsWith("audit-oct26/"));

/** Markdown with code blocks and inline code removed — examples are not links. */
function prose(file: string): string {
	return readFileSync(join(ROOT, file), "utf8")
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`[^`\n]*`/g, "");
}

describe("docs references", () => {
	it("every relative Markdown link resolves to a file in the repo", () => {
		const broken: string[] = [];
		for (const file of trackedMarkdown) {
			for (const m of prose(file).matchAll(/\]\(([^)\s]+)\)/g)) {
				const target = m[1];
				if (/^(https?:|mailto:|#)/.test(target)) continue;
				const path = target.split("#")[0];
				if (!path) continue;
				if (!existsSync(normalize(join(ROOT, dirname(file), path)))) {
					broken.push(`${file} → ${target}`);
				}
			}
		}
		expect(broken).toEqual([]);
	});

	it("every `npm run` script the operator docs name exists", () => {
		const packageJsons = [
			"package.json",
			...execFileSync("git", ["ls-files", "packages/*/package.json"], {
				cwd: ROOT,
				encoding: "utf8",
			})
				.split("\n")
				.filter(Boolean),
		];
		const scripts = new Set(
			packageJsons.flatMap((p) =>
				Object.keys(
					JSON.parse(readFileSync(join(ROOT, p), "utf8")).scripts ?? {},
				),
			),
		);
		const missing: string[] = [];
		for (const doc of [
			"CLAUDE.md",
			"USER_GUIDE.md",
			"README.md",
			"docs/deployment.md",
		]) {
			for (const m of readFileSync(join(ROOT, doc), "utf8").matchAll(
				/npm run ([\w:.-]+)/g,
			)) {
				if (!scripts.has(m[1])) missing.push(`${doc} → npm run ${m[1]}`);
			}
		}
		expect(missing).toEqual([]);
	});
});
