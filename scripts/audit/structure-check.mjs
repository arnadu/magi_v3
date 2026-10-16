#!/usr/bin/env node
/**
 * File- and function-length ratchet for CLAUDE.md's Code Structure thresholds.
 *
 * Scans packages/[*]/src/**[/]*.ts|tsx, flags files over FILE_MAX lines and functions over FN_MAX
 * lines, and compares against scripts/audit/structure.allow.json: a known offender may stay as
 * large as its recorded size but never grow; anything new over a threshold fails. Running with
 * --update rewrites the allowlist to the current sizes (only for entries that shrank, or to seed
 * it the first time) — the allowlist can only ratchet down.
 *
 * Usage: node scripts/audit/structure-check.mjs [--update] [--json]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const FILE_MAX = 600;
const FN_MAX = 120;
const ROOT = process.cwd();
const ALLOW_PATH = join(ROOT, "scripts/audit/structure.allow.json");
const update = process.argv.includes("--update");

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist" || name === "tests") continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) yield* walk(p);
		else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) yield p;
	}
}

function functionsOf(sourceFile) {
	const out = [];
	const nameOf = (node) => {
		if (node.name && ts.isIdentifier(node.name)) return node.name.text;
		if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
		if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
		if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
		return "<anonymous>";
	};
	const visit = (node) => {
		if (
			ts.isFunctionDeclaration(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isFunctionExpression(node) ||
			ts.isArrowFunction(node)
		) {
			if (node.body) {
				const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
				const end = sourceFile.getLineAndCharacterOfPosition(node.end).line;
				out.push({ name: nameOf(node), lines: end - start + 1, line: start + 1 });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return out;
}

const packagesDir = join(ROOT, "packages");
const current = {};
for (const pkg of readdirSync(packagesDir)) {
	const src = join(packagesDir, pkg, "src");
	let st;
	try {
		st = statSync(src);
	} catch {
		continue;
	}
	if (!st.isDirectory()) continue;
	for (const file of walk(src)) {
		const text = readFileSync(file, "utf8");
		const lines = text.split("\n").length;
		const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
		const bigFns = functionsOf(sf).filter((f) => f.lines > FN_MAX);
		if (lines > FILE_MAX || bigFns.length > 0) {
			const rel = relative(ROOT, file);
			current[rel] = { lines, fns: Object.fromEntries(bigFns.map((f) => [`${f.name}@${f.line}`, f.lines])) };
		}
	}
}

let allow = {};
try {
	allow = JSON.parse(readFileSync(ALLOW_PATH, "utf8"));
} catch {
	if (!update) {
		console.error(`structure-check: ${relative(ROOT, ALLOW_PATH)} missing — run with --update to seed it`);
		process.exit(2);
	}
}

const failures = [];
for (const [file, cur] of Object.entries(current)) {
	const known = allow[file];
	if (cur.lines > FILE_MAX && (!known || cur.lines > known.lines)) {
		failures.push(`${file}: ${cur.lines} lines (max ${FILE_MAX}${known ? `, allowlisted ${known.lines}` : ""})`);
	}
	for (const [fn, len] of Object.entries(cur.fns)) {
		// Functions are keyed by name@line; the line drifts as files are edited, so match by name.
		const name = fn.split("@")[0];
		const knownFn = known ? Object.entries(known.fns ?? {}).find(([k]) => k.split("@")[0] === name) : undefined;
		if (!knownFn || len > knownFn[1]) {
			failures.push(`${file} ${fn}: ${len} lines (max ${FN_MAX}${knownFn ? `, allowlisted ${knownFn[1]}` : ""})`);
		}
	}
}

if (update) {
	// Only ratchet down: keep the smaller of recorded and current for known entries; add new ones
	// only when seeding (no allowlist yet).
	const seeding = Object.keys(allow).length === 0;
	const next = {};
	for (const [file, cur] of Object.entries(current)) {
		const known = allow[file];
		if (!known && !seeding) continue;
		const fns = {};
		for (const [fn, len] of Object.entries(cur.fns)) {
			const name = fn.split("@")[0];
			const knownFn = known ? Object.entries(known.fns ?? {}).find(([k]) => k.split("@")[0] === name) : undefined;
			if (knownFn || seeding) fns[fn] = knownFn ? Math.min(knownFn[1], len) : len;
		}
		next[file] = { lines: known ? Math.min(known.lines, cur.lines) : cur.lines, fns };
	}
	writeFileSync(ALLOW_PATH, `${JSON.stringify(next, null, "\t")}\n`);
	console.log(`structure-check: allowlist ${seeding ? "seeded" : "ratcheted"} with ${Object.keys(next).length} files`);
	process.exit(0);
}

if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ current, failures }, null, 2));
}
if (failures.length > 0) {
	console.error(`structure-check: ${failures.length} new or grown oversize file(s)/function(s):`);
	for (const f of failures) console.error(`  ${f}`);
	process.exit(1);
}
console.log(`structure-check: ok (${Object.keys(current).length} known oversize files, none grew)`);
