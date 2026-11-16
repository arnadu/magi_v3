// Runs CodeQL for the trace: builds the database, runs the query pack in
// ql/ and the standard security suite, and returns plain rows.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SECURITY_SUITE =
	"codeql/javascript-queries:codeql-suites/javascript-security-extended.qls";

/** The CodeQL CLI: $CODEQL, or the copy install-codeql.sh put in $CODEQL_HOME. */
export function codeqlPath() {
	const home = process.env.CODEQL_HOME ?? join(homedir(), ".cache/magi/codeql");
	const path = process.env.CODEQL ?? join(home, "codeql/codeql");
	if (!existsSync(path))
		throw new Error(
			`CodeQL not found at ${path}: run scripts/trace/install-codeql.sh, or set CODEQL to the CLI's path`,
		);
	return path;
}

function run(cq, args, log) {
	try {
		execFileSync(cq, args, {
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 1 << 28,
		});
	} catch (e) {
		const out = `${e.stdout ?? ""}${e.stderr ?? ""}`
			.trim()
			.split("\n")
			.slice(-15)
			.join("\n");
		throw new Error(
			`codeql ${args[0]} ${args[1] ?? ""} failed (${log}):\n${out}`,
		);
	}
}

export function buildDatabase(cq, root, dbDir) {
	rmSync(dbDir, { recursive: true, force: true });
	run(
		cq,
		[
			"database",
			"create",
			dbDir,
			"--language=javascript",
			`--source-root=${root}`,
			`--codescanning-config=${join(root, "scripts/trace/codeql-config.yml")}`,
			"--overwrite",
		],
		"building the database",
	);
}

function decode(cq, bqrs) {
	const out = execFileSync(cq, ["bqrs", "decode", "--format=json", bqrs], {
		maxBuffer: 1 << 28,
	}).toString();
	const { columns, tuples } = JSON.parse(out)["#select"];
	return tuples.map((t) =>
		Object.fromEntries(columns.map((c, i) => [c.name, t[i]])),
	);
}

/** Runs every query in ql/; returns `{ <query name>: rows }`. */
export function runPack(cq, root, dbDir) {
	const pack = join(root, "scripts/trace/ql");
	run(
		cq,
		["database", "run-queries", dbDir, pack, "--threads=0"],
		"the trace queries",
	);
	const results = join(dbDir, "results/magi/trace");
	const out = {};
	for (const f of readdirSync(results))
		if (f.endsWith(".bqrs"))
			out[f.replace(/\.bqrs$/, "")] = decode(cq, join(results, f));
	return out;
}

/** Runs the standard security suite; returns its SARIF results. */
export function runSecurity(cq, dbDir, sarifPath) {
	run(
		cq,
		[
			"database",
			"analyze",
			dbDir,
			SECURITY_SUITE,
			"--format=sarif-latest",
			`--output=${sarifPath}`,
			"--threads=0",
		],
		"the security suite",
	);
	return JSON.parse(readFileSync(sarifPath, "utf8"));
}
