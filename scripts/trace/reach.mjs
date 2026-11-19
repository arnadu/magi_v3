// What each entry point reaches, from CodeQL's call graph. A function is
// reached when it is called from a reached function, or is nested in one (a
// closure a reached function returns or registers is taken as run). Calls
// CodeQL could not resolve are kept per entry point, so a report can say
// where its reach may be incomplete.

/**
 * @param {{ id: string, file: string, line: number, endLine: number, name: string, parent: string }[]} functions
 * @param {{ file: string, line: number, caller: string, calleeId: string }[]} calls
 * @param {{ file: string, line: number, caller: string, name: string }[]} unresolved
 */
export function callGraph(functions, calls, unresolved) {
	const byId = new Map(functions.map((f) => [f.id, f]));
	const byFile = new Map();
	for (const f of functions) {
		if (!byFile.has(f.file)) byFile.set(f.file, []);
		byFile.get(f.file).push(f);
	}
	const callees = new Map();
	const sitesByFile = new Map();
	for (const c of calls) {
		if (!callees.has(c.caller)) callees.set(c.caller, new Set());
		callees.get(c.caller).add(c.calleeId);
		if (!sitesByFile.has(c.file)) sitesByFile.set(c.file, []);
		sitesByFile.get(c.file).push(c);
	}
	const children = new Map();
	for (const f of functions)
		if (f.parent) {
			if (!children.has(f.parent)) children.set(f.parent, []);
			children.get(f.parent).push(f.id);
		}
	const gaps = new Map();
	for (const u of unresolved) {
		if (!gaps.has(u.caller)) gaps.set(u.caller, []);
		gaps.get(u.caller).push(u);
	}

	/** The innermost function containing `file:line`. */
	function functionAt(file, line) {
		let best = null;
		for (const f of byFile.get(file) ?? [])
			if (f.line <= line && line <= f.endLine)
				if (!best || f.endLine - f.line < best.endLine - best.line) best = f;
		return best;
	}

	/** Functions an entry point's registration starts: those defined in its span, those called from it, and named handlers. */
	function roots(span, names = []) {
		const out = new Set();
		for (const f of byFile.get(span.file) ?? []) {
			const inSpan = f.line >= span.line && f.endLine <= span.endLine;
			const parent = f.parent && byId.get(f.parent);
			const parentInSpan =
				parent &&
				parent.file === span.file &&
				parent.line >= span.line &&
				parent.endLine <= span.endLine;
			if (inSpan && !parentInSpan) out.add(f.id);
			if (names.includes(f.name)) out.add(f.id);
		}
		for (const c of sitesByFile.get(span.file) ?? [])
			if (c.line >= span.line && c.line <= span.endLine) out.add(c.calleeId);
		return out;
	}

	/** Function id -> HTTP routes it calls: `{ route, roots }`, set by linkHttpHops. */
	const hops = new Map();

	function reach(rootIds) {
		const seen = new Set(rootIds);
		const queue = [...rootIds];
		const via = new Set();
		while (queue.length > 0) {
			const id = queue.pop();
			const next = [...(callees.get(id) ?? []), ...(children.get(id) ?? [])];
			for (const h of hops.get(id) ?? []) {
				via.add(h.route);
				next.push(...h.roots);
			}
			for (const n of next)
				if (!seen.has(n)) {
					seen.add(n);
					queue.push(n);
				}
		}
		const unresolvedCalls = [...seen].flatMap((id) => gaps.get(id) ?? []);
		return {
			functions: [...seen].map((id) => byId.get(id)).filter(Boolean),
			unresolvedCalls,
			httpHops: [...via].sort(),
		};
	}

	return { functionAt, roots, reach, byId, byFile, hops };
}

/**
 * Links a function to the HTTP routes it calls, so reach crosses from one
 * process to another: the monitor's routes on the mission machine, and the
 * control plane's routes for the mission copilot. A function calls a route
 * when it holds the route's path as a string, or as the end of a template
 * literal (`${base}/pause-agent`); a path with parameters matches a literal
 * with the parameter interpolated.
 */
export function linkHttpHops(graph, entries, readSource) {
	const targets = entries
		.filter(
			(e) =>
				e.kind === "monitor-route" || (e.kind === "route" && e.actor === "MC"),
		)
		.map((e) => {
			const raw = e.name.slice(e.name.indexOf(" ") + 1);
			let test;
			if (raw.startsWith("/^")) {
				const re = new RegExp(raw.slice(1, raw.lastIndexOf("/")));
				test = (lit) => re.test(lit);
			} else {
				const paths = raw.startsWith("[")
					? [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1])
					: [raw.replace(/^"|"$/g, "")];
				test = (lit) => paths.some((p) => p.length > 2 && lit === p);
			}
			return { e, test };
		});
	for (const [file] of graph.byFile) {
		const text = readSource(file);
		if (!text) continue;
		text.split("\n").forEach((lineText, i) => {
			for (const m of lineText.matchAll(
				/(["'`])(\/[^"'`\s]*?)\1|`[^`]*?(\/[a-z][^`\s]*)`/g,
			)) {
				const lit = (m[2] ?? m[3] ?? "")
					.replace(/\$\{[^}]*\}/g, "x")
					.split("?")[0];
				if (!lit) continue;
				// Every suffix that starts at a "/" may be the route's path.
				const suffixes = [...lit.matchAll(/\//g)].map((s) =>
					lit.slice(s.index),
				);
				const fn = graph.functionAt(file, i + 1);
				if (!fn) continue;
				for (const { e, test } of targets)
					if (suffixes.some(test)) {
						if (!graph.hops.has(fn.id)) graph.hops.set(fn.id, []);
						graph.hops.get(fn.id).push({
							route: `${e.kind} ${e.name}`,
							roots: [...graph.roots(e)],
						});
					}
			}
		});
	}
}

/** Reach of every entry point, keyed by its index in `entries`. */
export function entryReach(graph, entries) {
	return entries.map((e) => {
		// A file request is read inside the function that processes the files:
		// that function is where the request starts.
		const reader =
			e.kind === "file-request" ? graph.functionAt(e.file, e.line) : null;
		const span = e.handler ?? reader ?? e;
		const ref = e.handler?.ref ?? e.ref;
		const names = ref ? [ref] : [];
		return graph.reach(graph.roots(span, names));
	});
}
