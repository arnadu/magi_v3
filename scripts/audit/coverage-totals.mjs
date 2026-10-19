#!/usr/bin/env node
/**
 * Per-package coverage totals from coverage/coverage-summary.json, in the
 * same groupings as vitest.config.ts's floors. CI prints these so the floors
 * can be set from CI's own numbers (local runs measure higher: CI skips the
 * tests that need pool users and setfacl).
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const summary = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));
const totals = new Map();
for (const [file, m] of Object.entries(summary)) {
	if (file === "total") continue;
	const pkg = relative(process.cwd(), file).split("/").slice(0, 2).join("/");
	const t = totals.get(pkg) ?? { statements: [0, 0], branches: [0, 0], functions: [0, 0] };
	for (const k of ["statements", "branches", "functions"]) {
		t[k][0] += m[k].covered;
		t[k][1] += m[k].total;
	}
	totals.set(pkg, t);
}
const pct = ([c, n]) => (n === 0 ? 100 : (100 * c) / n).toFixed(2);
console.log("coverage totals (statements / branches / functions):");
for (const [pkg, t] of [...totals].sort()) {
	console.log(
		`  ${pkg.padEnd(32)} ${pct(t.statements)} / ${pct(t.branches)} / ${pct(t.functions)}`,
	);
}
