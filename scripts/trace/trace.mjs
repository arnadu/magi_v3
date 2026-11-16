#!/usr/bin/env node
// `npm run trace`: scans the code and joins what it finds to the baseline
// catalog (ADR-0036). Writes its reports to analysis/ (or --out <dir>):
// index.md, operations.md, writes.md, security.md, invariants.md,
// components.html, their JSON, and todo.json, every finding with a stable key;
// the previous run's todo.json is kept in previous/ so new findings are marked.
//
// `npm run trace -- def|refs|callers|reach <argument>` answers one question
// instead (query.mjs).
//
// Options: --no-security (skip CodeQL's security suite, the slowest step),
// --reuse-db (keep an existing CodeQL database: faster, for repeated local
// runs on unchanged code), --out <dir>.

import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDatabase, codeqlPath, runPack, runSecurity } from "./codeql.mjs";
import {
	againstLayering,
	componentImports,
	renderComponentMap,
} from "./components.mjs";
import { extractEntryPoints } from "./entry-points.mjs";
import { computeFindings, markNew } from "./findings.mjs";
import { callGraph, entryReach, linkHttpHops } from "./reach.mjs";
import {
	renderIndex,
	renderInvariants,
	renderOperations,
	renderSecurity,
	renderWrites,
} from "./report-md.mjs";
import { QUERY_COMMANDS, runQuery } from "./query.mjs";
import { extractWrites } from "./writes.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);

if (QUERY_COMMANDS.has(args[0])) {
	try {
		runQuery(args);
		process.exit(0);
	} catch (e) {
		console.error(`[trace] ${e.message}`);
		process.exit(2);
	}
}
const outIdx = args.indexOf("--out");
const OUT = resolve(outIdx >= 0 ? args[outIdx + 1] : join(ROOT, "analysis"));
const DB = join(OUT, ".codeql-db");

const started = Date.now();
const step = (label) =>
	console.log(
		`[trace] ${label} (${((Date.now() - started) / 1000).toFixed(0)} s)`,
	);

const catalogPath = join(ROOT, "packages/agent-config/dist/index.js");
if (!existsSync(catalogPath)) {
	console.error(
		"[trace] the catalog is not built: run `npm run build -w packages/agent-config` first",
	);
	process.exit(2);
}
const { baseline: b } = await import(pathToFileURL(catalogPath).href);

function git(...a) {
	try {
		return execFileSync("git", a, { cwd: ROOT }).toString().trim();
	} catch {
		return "";
	}
}
const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
const meta = {
	commit: `${git("rev-parse", "--short", "HEAD") || "unknown"}${dirty ? " (with uncommitted changes)" : ""}`,
	time: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
};

mkdirSync(join(OUT, "previous"), { recursive: true });
let previous = null;
if (existsSync(join(OUT, "todo.json"))) {
	copyFileSync(join(OUT, "todo.json"), join(OUT, "previous/todo.json"));
	previous = JSON.parse(readFileSync(join(OUT, "todo.json"), "utf8")).findings;
}

step("entry points");
const entries = extractEntryPoints(ROOT);
step("database writes");
const writes = extractWrites();

const cq = codeqlPath();
if (!(flag("--reuse-db") && existsSync(DB))) {
	step("CodeQL database");
	buildDatabase(cq, ROOT, DB);
}
step("call graph");
const pack = runPack(cq, ROOT, DB);
const graph = callGraph(pack.functions, pack.calls, pack.unresolved);
linkHttpHops(graph, entries, (file) => {
	try {
		return readFileSync(join(ROOT, file), "utf8");
	} catch {
		return null;
	}
});
const reaches = entryReach(graph, entries);
entries.forEach((e, i) => {
	e.reach = reaches[i];
});
for (const w of writes) w.fn = graph.functionAt(w.file, w.line)?.id ?? null;

let sarif = null;
if (!flag("--no-security")) {
	step("security suite");
	sarif = runSecurity(cq, DB, join(OUT, "security.sarif"));
}

step("join");
const imports = componentImports(b, ROOT);
const result = computeFindings(
	b,
	entries,
	writes,
	sarif,
	againstLayering(b, imports.edges),
);
markNew(result.findings, previous);

const json = (name, data) =>
	writeFileSync(join(OUT, name), `${JSON.stringify(data, null, 1)}\n`);
json(
	"entry-points.json",
	entries.map(({ reach, ...e }) => ({
		...e,
		reached: reach.functions.map((f) => `${f.name} ${f.file}:${f.line}`).sort(),
		unresolved: reach.unresolvedCalls.map(
			(u) => `${u.name} ${u.file}:${u.line}`,
		),
		httpHops: reach.httpHops,
	})),
);
json("operations.json", result.operations);
json("writes.json", result.writes);
json("security.json", result.security);
json("invariants.json", result.invariants);
json("todo.json", { meta, findings: result.findings });
writeFileSync(
	join(OUT, "operations.md"),
	renderOperations(meta, result.operations, result.findings),
);
writeFileSync(
	join(OUT, "writes.md"),
	renderWrites(meta, result.writes, result.findings, b),
);
writeFileSync(
	join(OUT, "security.md"),
	renderSecurity(meta, result.security, result.invariants, !!sarif),
);
writeFileSync(
	join(OUT, "invariants.md"),
	renderInvariants(meta, result.invariants),
);
writeFileSync(join(OUT, "components.html"), renderComponentMap(meta, b, imports));

const counts = {
	"Entry points": entries.length,
	"Operations in the catalog": b.OPERATIONS.length,
	"Database writes": writes.length,
	"Functions in the call graph": pack.functions.length,
	"Calls resolved / unresolved (by name)": `${pack.calls.length} / ${pack.unresolved.length}`,
	"Security results": sarif ? result.security.length : "not run",
	Findings: result.findings.length,
};
const index = renderIndex(meta, counts, result.findings, previous !== null);
writeFileSync(join(OUT, "index.md"), index);
if (process.env.GITHUB_STEP_SUMMARY)
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, index);
step(`done: ${result.findings.length} findings in ${OUT}`);
