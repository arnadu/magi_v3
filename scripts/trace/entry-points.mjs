#!/usr/bin/env node
// Lists every entry point of MAGI (the routes, tools, copilot actions, Tool
// API names and triggers an actor or the platform can start work through)
// with the operation or entry class it declares (ADR-0036). Static, from the
// TypeScript AST. `packages/agent-config/tests/entry-points.unit.test.ts`
// fails on an entry point without a valid tag.
//
// Usage: node scripts/trace/entry-points.mjs [--json] [--untagged]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ts = createRequire(join(ROOT, "package.json"))("typescript");

const CP = "packages/control-plane/src";
const MM = "packages/agent-runtime-worker/src";
const VERBS = new Set(["get", "post", "put", "patch", "delete"]);

function walk(dir) {
	const out = [];
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
	}
	return out;
}

const isStr = (n) => n && ts.isStringLiteralLike(n);

function prop(obj, name) {
	return obj.properties.find(
		(p) =>
			(ts.isPropertyAssignment(p) ||
				ts.isMethodDeclaration(p) ||
				ts.isShorthandPropertyAssignment(p)) &&
			p.name &&
			(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
			p.name.text === name,
	);
}

function strProp(obj, name) {
	const p = prop(obj, name);
	return p && ts.isPropertyAssignment(p) && isStr(p.initializer)
		? p.initializer.text
		: null;
}

/** `name("tag", …)`, returning the tag. */
function callTag(n, name) {
	return ts.isCallExpression(n) &&
		ts.isIdentifier(n.expression) &&
		n.expression.text === name &&
		isStr(n.arguments[0])
		? n.arguments[0].text
		: null;
}

function contains(node, pred) {
	let found = null;
	const visit = (n) => {
		if (found) return;
		const r = pred(n);
		if (r) found = r;
		else ts.forEachChild(n, visit);
	};
	visit(node);
	return found;
}

function enclosingFunction(n) {
	let p = n.parent;
	while (p && !ts.isFunctionLike(p)) p = p.parent;
	return p;
}

/** "cron <expr>: <fn>", "interval: <fn>", "change stream", or "<host> callback". */
function triggerName(call, sf) {
	const fn = call.arguments[1];
	const named = fn && ts.isIdentifier(fn) ? `: ${fn.text}` : "";
	let p = call.parent;
	while (p && !ts.isCallExpression(p) && !ts.isFunctionLike(p)) p = p.parent;
	if (!p || !ts.isCallExpression(p)) return `callback${named}`;
	const host = p.expression;
	const hostName = ts.isIdentifier(host)
		? host.text
		: ts.isPropertyAccessExpression(host)
			? host.name.text
			: "";
	if (hostName === "schedule" && isStr(p.arguments[0]))
		return `cron ${p.arguments[0].text}${named}`;
	if (hostName === "setInterval") return `interval${named}`;
	if ((hostName === "on" || hostName === "once") && isStr(p.arguments[0]))
		return `${p.arguments[0].text} event`;
	return `${hostName} callback${named}`;
}

function toolActor(file) {
	if (file.startsWith(CP)) return "CC";
	if (file.endsWith("image-agent-tools.ts")) return "sub-agent";
	// Reached only through the Tool API, by background jobs.
	if (file.endsWith("data-provider-proxy.ts")) return "JOB";
	if (/\/mission-copilot|\/resource-upgrade-tool\.ts$/.test(file)) return "MC";
	return "AG";
}

/**
 * Every entry point: `{ kind, actor, file, line, name, tag }`, `tag` null
 * when the entry point declares none. Kinds: `route` (control-plane Express),
 * `monitor-route` (mission machine), `tool`, `copilot-action`, `tool-api`
 * (background jobs), `trigger` (timers, change streams, callbacks).
 */
export function extractEntryPoints(root = ROOT) {
	const entries = [];
	const files = [CP, MM].flatMap((d) => walk(join(root, d)));
	for (const abs of files) {
		const file = relative(root, abs);
		const sf = ts.createSourceFile(
			abs,
			readFileSync(abs, "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		const add = (kind, actor, node, name, tag) =>
			entries.push({
				kind,
				actor,
				file,
				line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
				name,
				tag: tag ?? null,
			});

		const visit = (n) => {
			// Express: <router>.<verb>("/path", <tag> | operation("<tag>"), …handlers)
			if (
				file.startsWith(CP) &&
				ts.isCallExpression(n) &&
				ts.isPropertyAccessExpression(n.expression) &&
				VERBS.has(n.expression.name.text) &&
				n.arguments.length >= 2 &&
				isStr(n.arguments[0]) &&
				n.arguments[0].text.startsWith("/")
			) {
				const second = n.arguments[1];
				const tag = isStr(second) ? second.text : callTag(second, "operation");
				const actor = file.endsWith("mission-copilot-router.ts") ? "MC" : "OP";
				add(
					"route",
					actor,
					n,
					`${n.expression.name.text.toUpperCase()} ${n.arguments[0].text}`,
					tag,
				);
			}
			if (ts.isObjectLiteralExpression(n)) {
				// Monitor routes: { method, path, operation, handler }
				const method = strProp(n, "method");
				const path = prop(n, "path");
				if (file.startsWith(MM) && method && path && prop(n, "handler")) {
					add(
						"monitor-route",
						"OP",
						n,
						`${method} ${path.initializer.getText(sf)}`,
						strProp(n, "operation"),
					);
				}
				// Tools: { name, operation, execute }
				const name = strProp(n, "name");
				if (name && prop(n, "execute"))
					add("tool", toolActor(file), n, name, strProp(n, "operation"));
				// Tool API: { names: [...], operation, build }
				const names = prop(n, "names");
				if (
					names &&
					prop(n, "build") &&
					ts.isArrayLiteralExpression(names.initializer)
				) {
					const first = names.initializer.elements.find(isStr);
					add(
						"tool-api",
						"JOB",
						n,
						first?.text ?? "?",
						strProp(n, "operation"),
					);
				}
			}
			// Copilot actions: ACTION_OPERATIONS = { <action>: "<tag>", … }
			if (
				ts.isVariableDeclaration(n) &&
				ts.isIdentifier(n.name) &&
				n.name.text === "ACTION_OPERATIONS" &&
				n.initializer &&
				ts.isObjectLiteralExpression(n.initializer)
			) {
				for (const p of n.initializer.properties) {
					if (!ts.isPropertyAssignment(p)) continue;
					const key = p.name.getText(sf).replace(/^\[|\]$/g, "");
					add(
						"copilot-action",
						"CC",
						p,
						key,
						isStr(p.initializer) ? p.initializer.text : null,
					);
				}
			}
			// Triggers: entryTrigger("<tag>", fn), and every cron schedule,
			// setInterval or change stream, which must be tagged.
			if (ts.isCallExpression(n)) {
				const tag = callTag(n, "entryTrigger");
				const callee = n.expression;
				const fn = ts.isIdentifier(callee)
					? callee.text
					: ts.isPropertyAccessExpression(callee)
						? callee.name.text
						: "";
				const isCron =
					ts.isIdentifier(callee) && fn === "schedule" && isStr(n.arguments[0]);
				const isTimer = ts.isIdentifier(callee) && fn === "setInterval";
				const isStream =
					ts.isPropertyAccessExpression(callee) && fn === "watch";
				if (isCron || isTimer || isStream) {
					const own = n.arguments
						.map((a) => contains(a, (x) => callTag(x, "entryTrigger")))
						.find(Boolean);
					const scope = enclosingFunction(n);
					const inScope =
						scope && contains(scope, (x) => callTag(x, "entryTrigger"));
					const label = isCron
						? `cron ${n.arguments[0].text}`
						: isTimer
							? "interval"
							: "change stream";
					if (!own && !inScope) add("trigger", "PLT", n, label, null);
				}
				if (tag !== null) add("trigger", "PLT", n, triggerName(n, sf), tag);
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return entries;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	let entries = extractEntryPoints();
	if (process.argv.includes("--untagged"))
		entries = entries.filter((e) => e.tag === null);
	if (process.argv.includes("--json")) {
		console.log(JSON.stringify(entries, null, 1));
	} else {
		for (const e of entries)
			console.log(
				`${e.tag ?? "UNTAGGED"}\t${e.kind}\t${e.actor}\t${e.file}:${e.line}\t${e.name}`,
			);
		const untagged = entries.filter((e) => e.tag === null).length;
		console.log(`${entries.length} entry points, ${untagged} untagged`);
	}
}
