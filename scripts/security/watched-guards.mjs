#!/usr/bin/env node
/**
 * Before a push: if it changes a watched guard (scripts/security/watched-guards.json), one of its
 * commits must carry a "Security review:" line saying how the change was reviewed. Exit 1
 * otherwise. Run by .githooks/pre-push; `--list` prints the guards.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { guards } = JSON.parse(
	readFileSync(join(ROOT, "scripts/security/watched-guards.json"), "utf8"),
);
const git = (...args) =>
	execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

if (process.argv.includes("--list")) {
	for (const g of guards)
		console.log(`${g.path}  (${g.invariant}, ${g.boundary})`);
	process.exit(0);
}
let base;
try {
	base = git("merge-base", "HEAD", "origin/main");
} catch {
	base = git("rev-parse", "HEAD~1");
}
const changed = new Set(
	git("diff", "--name-only", base, "HEAD").split("\n").filter(Boolean),
);
const touched = guards.filter((g) => changed.has(g.path));
if (touched.length === 0) {
	console.log("[watched-guards] no watched guard changed");
	process.exit(0);
}
const messages = git("log", "--format=%B", `${base}..HEAD`);
const reviewed = /^Security review:\s*\S/m.test(messages);
for (const g of touched) {
	console.log(
		`[watched-guards] ${g.path} changed (${g.invariant}, ${g.boundary}): ${g.why}`,
	);
	console.log(`  its tests: ${g.tests.join(", ")}`);
}
if (!reviewed) {
	console.log(
		"[watched-guards] BLOCKED: a watched guard changed and no commit in this push has a 'Security review:' line. Review the change (/security-review), then add the line to the commit message saying what was reviewed and the result.",
	);
	process.exit(1);
}
console.log("[watched-guards] a 'Security review:' line is present");
