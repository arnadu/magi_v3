// One question about the code, answered from the sources with the TypeScript
// language service (no CodeQL database needed), or from the last trace:
//
//   npm run trace -- def <name>             where <name> is declared
//   npm run trace -- refs <file:line[:col]> every reference to the symbol there
//   npm run trace -- callers <file:line[:col]> [--depth N]
//                                           who calls the function there, N levels up
//   npm run trace -- reach <operation id or entry point name> [--analysis <dir>]
//                                           what an entry point reaches, from the last
//                                           trace's reports (default: analysis/)
//
// A position is given as a path from the repository root and a 1-based line;
// without a column, the first identifier on the line is used.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platformProgram } from "./writes.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ts = createRequire(join(ROOT, "package.json"))("typescript");

function languageService() {
	const program = platformProgram();
	const files = program.getRootFileNames();
	const options = program.getCompilerOptions();
	const host = {
		getScriptFileNames: () => files,
		getScriptVersion: () => "1",
		getScriptSnapshot: (f) =>
			existsSync(f)
				? ts.ScriptSnapshot.fromString(readFileSync(f, "utf8"))
				: undefined,
		getCurrentDirectory: () => ROOT,
		getCompilationSettings: () => options,
		getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
	};
	return { ls: ts.createLanguageService(host), program };
}

const where = (program, fileName, pos) => {
	const sf = program.getSourceFile(fileName);
	const { line } = sf.getLineAndCharacterOfPosition(pos);
	return `${relative(ROOT, fileName)}:${line + 1}  ${sf.text.split("\n")[line].trim().slice(0, 100)}`;
};

/** `file:line[:col]` -> absolute file and offset of the identifier there. */
function position(program, spec) {
	const m = spec.match(/^(.+?):(\d+)(?::(\d+))?$/);
	if (!m) throw new Error(`expected <file>:<line>[:<col>], got "${spec}"`);
	const file = resolve(ROOT, m[1]);
	const sf = program.getSourceFile(file);
	if (!sf) throw new Error(`${m[1]} is not among the platform's sources`);
	const lineStart = sf.getPositionOfLineAndCharacter(Number(m[2]) - 1, 0);
	if (m[3]) return { file, pos: lineStart + Number(m[3]) - 1 };
	const lineText = sf.text.slice(lineStart).split("\n")[0];
	// The first identifier after a declaration keyword, else the first identifier.
	const decl = lineText.match(
		/\b(?:function|const|let|class|interface|type|async function)\s+([A-Za-z_$][\w$]*)/,
	);
	const id = decl ?? lineText.match(/[A-Za-z_$][\w$]*/);
	return {
		file,
		pos: lineStart + id.index + (decl ? id[0].indexOf(id[1]) : 0),
	};
}

function def(name) {
	const { program } = languageService();
	const out = [];
	for (const sf of program.getSourceFiles()) {
		if (!relative(ROOT, sf.fileName).match(/^packages\/[^/]+\/src\//)) continue;
		const visit = (n) => {
			if (
				(ts.isFunctionDeclaration(n) ||
					ts.isClassDeclaration(n) ||
					ts.isInterfaceDeclaration(n) ||
					ts.isTypeAliasDeclaration(n) ||
					ts.isVariableDeclaration(n) ||
					ts.isMethodDeclaration(n) ||
					ts.isPropertyAssignment(n)) &&
				n.name?.getText(sf) === name
			)
				out.push(where(program, sf.fileName, n.getStart(sf)));
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return out;
}

function refs(spec) {
	const { ls, program } = languageService();
	const { file, pos } = position(program, spec);
	return (ls.findReferences(file, pos) ?? []).flatMap((r) =>
		r.references.map((x) => where(program, x.fileName, x.textSpan.start)),
	);
}

function callers(spec, depth) {
	const { ls, program } = languageService();
	const { file, pos } = position(program, spec);
	const out = [];
	const seen = new Set();
	const walk = (item, level) => {
		if (level > depth) return;
		for (const c of ls.provideCallHierarchyIncomingCalls(
			item.file,
			item.selectionSpan.start,
		)) {
			const k = `${c.from.file}:${c.from.selectionSpan.start}`;
			out.push(
				`${"  ".repeat(level - 1)}${c.from.name}  ${where(program, c.from.file, c.fromSpans[0]?.start ?? c.from.selectionSpan.start)}`,
			);
			if (!seen.has(k)) {
				seen.add(k);
				walk(c.from, level + 1);
			}
		}
	};
	const items = [ls.prepareCallHierarchy(file, pos)].flat().filter(Boolean);
	if (items.length === 0) throw new Error(`no function at ${spec}`);
	for (const item of items) walk(item, 1);
	return out;
}

/**
 * What each entry point named or tagged `what` reaches, from the
 * `entry-points.json` in `dir` (a trace's reports: a local run's `analysis/`,
 * or reports fetched from elsewhere).
 */
export function reach(what, dir = join(ROOT, "analysis")) {
	const path = join(dir, "entry-points.json");
	if (!existsSync(path))
		throw new Error(
			`no ${path}: run \`npm run trace\` first, or pass --analysis <dir>`,
		);
	const entries = JSON.parse(readFileSync(path, "utf8"));
	const chosen = entries.filter((e) => e.tag === what || e.name === what);
	if (chosen.length === 0)
		throw new Error(`no entry point named or tagged "${what}"`);
	return chosen.flatMap((e) => [
		`${e.kind} ${e.name} (${e.actor}) ${e.file}:${e.line} serves ${e.tag}`,
		...(e.httpHops?.length ? [`  via HTTP: ${e.httpHops.join(", ")}`] : []),
		...e.reached.map((f) => `  ${f}`),
		...(e.unresolved.length
			? [
					"  unresolved calls (reach may be incomplete):",
					...e.unresolved.map((u) => `    ${u}`),
				]
			: []),
	]);
}

export function runQuery(args) {
	const [cmd, arg] = args;
	const depthIdx = args.indexOf("--depth");
	const depth = depthIdx >= 0 ? Number(args[depthIdx + 1]) : 1;
	const analysisIdx = args.indexOf("--analysis");
	const analysis =
		analysisIdx >= 0 ? resolve(args[analysisIdx + 1]) : undefined;
	if (!arg)
		throw new Error(
			"usage: npm run trace -- def|refs|callers|reach <argument>",
		);
	const lines =
		cmd === "def"
			? def(arg)
			: cmd === "refs"
				? refs(arg)
				: cmd === "callers"
					? callers(arg, depth)
					: reach(arg, analysis);
	console.log(lines.length ? lines.join("\n") : "(nothing found)");
}

export const QUERY_COMMANDS = new Set(["def", "refs", "callers", "reach"]);
