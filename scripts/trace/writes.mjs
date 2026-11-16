// Every MongoDB write in the platform's source: which collection it targets,
// and for a write that sets a status, the state it writes and the states its
// filter lets it start from. Uses the TypeScript compiler's types, so a
// collection handed around as `Collection<MissionDoc>` is still recognised.
//
// Usage: node scripts/trace/writes.mjs [--json]

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ts = createRequire(join(ROOT, "package.json"))("typescript");

const PACKAGES = ["agent-config", "control-plane", "agent-runtime-worker"];
const WRITE_METHODS = new Set([
	"insertOne",
	"insertMany",
	"updateOne",
	"updateMany",
	"replaceOne",
	"deleteOne",
	"deleteMany",
	"findOneAndUpdate",
	"findOneAndReplace",
	"findOneAndDelete",
	"bulkWrite",
]);
const UPDATES = new Set(["updateOne", "updateMany", "findOneAndUpdate"]);
const INSERTS = new Set(["insertOne", "insertMany"]);

/**
 * One program over the platform's sources, with `@magi/*` imports mapped to
 * source instead of `dist/`, so a helper in another package can be followed
 * into its body.
 */
export function platformProgram() {
	const configPath = join(ROOT, "packages/control-plane/tsconfig.json");
	const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dirname(configPath));
	const files = PACKAGES.flatMap((pkg) => {
		const c = join(ROOT, "packages", pkg, "tsconfig.json");
		return ts.parseJsonConfigFileContent(
			ts.readConfigFile(c, ts.sys.readFile).config,
			ts.sys,
			dirname(c),
		).fileNames;
	});
	return ts.createProgram(files, {
		...parsed.options,
		noEmit: true,
		rootDir: ROOT,
		baseUrl: ROOT,
		paths: Object.fromEntries(
			PACKAGES.map((pkg) => [`@magi/${pkg}`, [`packages/${pkg}/src/index.ts`]]),
		),
	});
}

/** COLLECTION_NAMES: collection name -> key, read from the source. */
function collectionKeys() {
	const src = readFileSync(
		join(ROOT, "packages/agent-config/src/stored/collections.ts"),
		"utf8",
	);
	const block = src.slice(src.indexOf("COLLECTION_NAMES = {"));
	const out = new Map();
	for (const m of block
		.slice(0, block.indexOf("} as const"))
		.matchAll(/(\w+):\s*"([^"]+)"/g))
		out.set(m[2], m[1]);
	return out;
}

const unwrap = (e) => {
	while (
		e &&
		(ts.isParenthesizedExpression(e) ||
			ts.isAsExpression(e) ||
			ts.isAwaitExpression(e) ||
			ts.isNonNullExpression(e) ||
			ts.isSatisfiesExpression?.(e))
	)
		e = e.expression;
	return e;
};

function stringLiterals(checker, node) {
	const t = checker.getTypeAtLocation(node);
	const parts = t.isUnion() ? t.types : [t];
	const out = parts.filter((p) => p.isStringLiteral()).map((p) => p.value);
	return out.length === parts.length && out.length > 0 ? out : null;
}

export function extractWrites() {
	const names = collectionKeys();
	const prog = platformProgram();
	const checker0 = prog.getTypeChecker();
	const sources = [];
	for (const sf of prog.getSourceFiles()) {
		const rel = relative(ROOT, sf.fileName);
		if (/^packages\/[^/]+\/src\//.test(rel))
			sources.push({ sf, rel, checker: checker0 });
	}

	// Where collections are created: learn type name -> key, and node -> key.
	const typeToKey = new Map();
	const ambiguous = new Set();
	const creationKey = (checker, call) => {
		const c = unwrap(call);
		if (!c || !ts.isCallExpression(c)) return null;
		const callee = c.expression;
		const name = ts.isIdentifier(callee)
			? callee.text
			: ts.isPropertyAccessExpression(callee)
				? callee.name.text
				: "";
		if (name === "storedCollection" && c.arguments[1]) {
			const lits = stringLiterals(checker, c.arguments[1]);
			return lits?.length === 1 ? lits[0] : null;
		}
		if (name === "collection" && c.arguments[0]) {
			const lits = stringLiterals(checker, c.arguments[0]);
			return lits?.length === 1 ? (names.get(lits[0]) ?? null) : null;
		}
		return null;
	};
	const docTypeName = (checker, node) => {
		const t = checker.getTypeAtLocation(node);
		const sym = t.getSymbol() ?? t.aliasSymbol;
		if (sym?.getName() !== "Collection") return null;
		const arg = checker.getTypeArguments?.(t)?.[0] ?? t.aliasTypeArguments?.[0];
		if (!arg) return null;
		const s = arg.aliasSymbol ?? arg.getSymbol();
		return s ? s.getName() : checker.typeToString(arg);
	};
	for (const { sf, checker } of sources) {
		const visit = (n) => {
			if (ts.isCallExpression(n)) {
				const key = creationKey(checker, n);
				const tn = key && docTypeName(checker, n);
				if (key && tn && tn !== "Document") {
					if (typeToKey.has(tn) && typeToKey.get(tn) !== key) ambiguous.add(tn);
					typeToKey.set(tn, key);
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	for (const tn of ambiguous) typeToKey.delete(tn);

	/** Follow a receiver back to where its collection was created. */
	function originKey(checker, expr, depth = 0) {
		if (depth > 4) return null;
		const e = unwrap(expr);
		const direct = creationKey(checker, e);
		if (direct) return direct;
		if (ts.isCallExpression(e)) {
			// A helper that returns a collection: `collection(db)`.
			const decl = checker.getResolvedSignature(e)?.getDeclaration();
			if (decl?.body) {
				let found = null;
				const scan = (n) => {
					if (found) return;
					if (ts.isReturnStatement(n) && n.expression)
						found = originKey(checker, n.expression, depth + 1);
					else ts.forEachChild(n, scan);
				};
				if (ts.isBlock(decl.body)) scan(decl.body);
				else found = originKey(checker, decl.body, depth + 1);
				if (found) return found;
			}
		}
		if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
			const sym = checker.getSymbolAtLocation(e);
			const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
			if (decl && ts.isVariableDeclaration(decl) && decl.initializer)
				return originKey(checker, decl.initializer, depth + 1);
		}
		return null;
	}

	const enclosingFunction = (n) => {
		let p = n.parent;
		while (p && !ts.isFunctionLike(p)) p = p.parent;
		return p;
	};
	const functionName = (f) => {
		if (!f) return "(module)";
		if (f.name) return f.name.getText();
		const p = f.parent;
		if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p))
			return p.name.getText();
		if (ts.isCallExpression(p))
			return `${p.expression.getText().slice(0, 40)}(callback)`;
		return "(anonymous)";
	};

	/** Call sites of a function: [call, checker] pairs across all programs. */
	const callsTo = new Map();
	function callers(fn) {
		if (callsTo.has(fn)) return callsTo.get(fn);
		const out = [];
		for (const { sf, checker } of sources) {
			const visit = (n) => {
				if (ts.isCallExpression(n)) {
					const d = checker.getResolvedSignature(n)?.getDeclaration();
					if (d && (d === fn || d.original === fn))
						out.push({ call: n, checker, sf });
				}
				ts.forEachChild(n, visit);
			};
			visit(sf);
		}
		callsTo.set(fn, out);
		return out;
	}

	/** States a value can be: literals, a literal union type, or the literals its callers pass. */
	function states(checker, expr) {
		const e = unwrap(expr);
		if (!e) return null;
		if (ts.isStringLiteralLike(e)) return { values: [e.text], via: "literal" };
		const sym = ts.isIdentifier(e) ? checker.getSymbolAtLocation(e) : null;
		const decl = sym?.valueDeclaration;
		if (decl && ts.isParameter(decl)) {
			const fn = decl.parent;
			const index = fn.parameters.indexOf(decl);
			const values = new Set();
			let complete = true;
			for (const { call, checker: c } of callers(fn)) {
				const a = call.arguments[index];
				const lits =
					a &&
					(ts.isStringLiteralLike(unwrap(a))
						? [unwrap(a).text]
						: stringLiterals(c, a));
				if (lits) for (const v of lits) values.add(v);
				else complete = false;
			}
			if (values.size > 0)
				return {
					values: [...values],
					via: complete ? "callers" : "some callers",
				};
		}
		const lits = stringLiterals(checker, e);
		return lits
			? { values: lits, via: "type" }
			: { values: null, via: e.getText().slice(0, 40) };
	}

	const objectOf = (checker, expr) => {
		let e = unwrap(expr);
		if (e && ts.isIdentifier(e)) {
			const d = checker.getSymbolAtLocation(e)?.valueDeclaration;
			if (d && ts.isVariableDeclaration(d) && d.initializer)
				e = unwrap(d.initializer);
		}
		return e && ts.isObjectLiteralExpression(e) ? e : null;
	};
	const propOf = (obj, name) =>
		obj?.properties.find(
			(p) =>
				(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
				p.name.getText().replace(/^["']|["']$/g, "") === name,
		);
	const propValue = (p) =>
		p && (ts.isPropertyAssignment(p) ? p.initializer : p.name);

	/** The filter's constraint on `status`: any, or eq/in/ne/nin a set of values. */
	function filterOn(checker, filterExpr) {
		const obj = objectOf(checker, filterExpr);
		if (!obj) return { op: "unknown" };
		const p = propOf(obj, "status");
		if (!p) return { op: "any" };
		const v = unwrap(propValue(p));
		if (ts.isObjectLiteralExpression(v)) {
			for (const op of ["$ne", "$in", "$nin", "$eq"]) {
				const q = propOf(v, op);
				if (!q) continue;
				const val = unwrap(propValue(q));
				const values = ts.isArrayLiteralExpression(val)
					? val.elements.flatMap((x) => states(checker, x).values ?? ["?"])
					: (states(checker, val).values ?? ["?"]);
				return { op: op.slice(1), values };
			}
			return { op: "unknown" };
		}
		const s = states(checker, v);
		return { op: "eq", values: s.values ?? ["?"], via: s.via };
	}

	const writes = [];
	for (const { sf, rel, checker } of sources) {
		const visit = (n) => {
			if (
				ts.isCallExpression(n) &&
				ts.isPropertyAccessExpression(n.expression) &&
				WRITE_METHODS.has(n.expression.name.text)
			) {
				const method = n.expression.name.text;
				const recv = n.expression.expression;
				const tn = docTypeName(checker, recv);
				if (
					tn !== null ||
					creationKey(checker, recv) ||
					originKey(checker, recv)
				) {
					const collection =
						(tn && tn !== "Document" && typeToKey.get(tn)) ||
						originKey(checker, recv) ||
						null;
					const row = {
						file: rel,
						line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
						function: functionName(enclosingFunction(n)),
						method,
						collection,
						docType: tn,
					};
					let doc = null;
					if (UPDATES.has(method))
						doc = propValue(propOf(objectOf(checker, n.arguments[1]), "$set"));
					else if (INSERTS.has(method) || method === "replaceOne")
						doc = method === "replaceOne" ? n.arguments[1] : n.arguments[0];
					const statusProp = doc && propOf(objectOf(checker, doc), "status");
					if (statusProp) {
						const s = states(checker, propValue(statusProp));
						row.status = {
							to: s.values ?? ["?"],
							toVia: s.via,
							from: INSERTS.has(method)
								? { op: "none" }
								: filterOn(checker, n.arguments[0]),
						};
					}
					writes.push(row);
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return writes;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const writes = extractWrites();
	if (process.argv.includes("--json"))
		console.log(JSON.stringify(writes, null, 1));
	else {
		for (const w of writes) {
			const st = w.status
				? ` status ${JSON.stringify(w.status.from)} -> ${w.status.to.join("|")} (${w.status.toVia})`
				: "";
			console.log(
				`${w.collection ?? "?"}\t${w.method}\t${w.file}:${w.line}\t${w.function}${st}`,
			);
		}
		const unknown = writes.filter((w) => !w.collection).length;
		console.log(
			`${writes.length} writes, ${unknown} with an unknown collection`,
		);
	}
}
