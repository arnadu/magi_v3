// Joins the scans to the baseline catalog and states where they disagree.
// Every finding names the baseline id it is about, carries file:line
// evidence, and has a stable key so a run can tell what is new.

import { createHash } from "node:crypto";

/** CodeQL security rules -> the security invariant each one checks. */
const RULE_INVARIANT = [
	[/^js\/(sql-injection|nosql-injection)/, "sec.tenant-scoped"],
	[/^js\/(path-injection|zipslip|tainted-path|file-system-race)/, "sec.contained-paths"],
	[
		/^js\/(request-forgery|server-side-request-forgery|client-side-request-forgery)/,
		"sec.safe-egress",
	],
	[
		/^js\/(xss|reflected-xss|stored-xss|xss-through-dom|xss-through-exception|html-constructed-from-input|unsafe-html-construction|unsafe-jquery-plugin)/,
		"sec.output-safe",
	],
	[
		/^js\/(clear-text-logging|clear-text-storage-of-sensitive-data|build-artifact-leak|file-access-to-http|stack-trace-exposure|insufficient-password-hash|weak-cryptographic-algorithm)/,
		"sec.secrets-not-recorded",
	],
	[
		/^js\/(hardcoded-credentials|exposure-of-private-files)/,
		"sec.no-secrets-to-agents",
	],
	[
		/^js\/(missing-token-validation|cors-misconfiguration-for-credentials|cors-permissive-configuration|insecure-helmet-configuration)/,
		"sec.authenticated",
	],
	[
		/^js\/(user-controlled-bypass|different-kinds-comparison-bypass)/,
		"sec.authorized",
	],
	[
		/^js\/(command-line-injection|shell-command|second-order-command-line-injection|indirect-command-line-injection|unsafe-shell-command-construction)/,
		"sec.least-privilege",
	],
	[
		/^js\/(regex-injection|polynomial-redos|redos|prototype-pollution|prototype-polluting|remote-property-injection|unsafe-deserialization|code-injection|unsafe-dynamic-method-access|unvalidated-dynamic-method-call|incomplete-sanitization|incomplete-multi-character-sanitization|incomplete-html-attribute-sanitization|bad-tag-filter|loop-bound-injection|type-confusion-through-parameter-tampering|resource-exhaustion|tainted-format-string|log-injection|xxe|xml-bomb|template-object-injection)/,
		"sec.input-validated",
	],
];

export const ACTOR_OF_KIND = {
	route: "OP",
	"monitor-route": "OP",
	"tool-api": "JOB",
	trigger: "PLT",
	"copilot-action": "CC",
};

function key(...parts) {
	return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

const at = (file, line) => `${file}:${line}`;

/**
 * @param {object} b the baseline module (`@magi/agent-config` baseline)
 * @param {object[]} entries entry points with `reach` attached
 * @param {object[]} writes MongoDB writes from writes.mjs, with `fn` (function id) attached
 * @param {object|null} sarif the security suite's SARIF, or null when it was not run
 */
export function computeFindings(b, entries, writes, sarif) {
	const findings = [];
	const add = (kind, about, text, where = [], detail = {}) =>
		findings.push({
			key: key(kind, about, text, ...where),
			kind,
			about,
			text,
			where,
			...detail,
		});
	const opById = new Map(b.OPERATIONS.map((o) => [o.id, o]));
	const component = (file) => b.componentsOwning(file)[0] ?? "(none)";
	const writeId = (w) =>
		`${w.collection ?? "?"}.${w.method}@${at(w.file, w.line)}`;

	// ── Operations ────────────────────────────────────────────────────────
	const operations = b.OPERATIONS.map((op) => {
		const eps = entries.filter((e) => e.tag === op.id);
		const rows = eps.map((e) => {
			const files = new Set(e.reach.functions.map((f) => f.file));
			const reachedComponents = [...new Set([...files].map(component))].sort();
			const fnIds = new Set(e.reach.functions.map((f) => f.id));
			const reachedWrites = writes
				.filter((w) => w.fn && fnIds.has(w.fn))
				.map(writeId);
			return {
				kind: e.kind,
				actor: e.actor,
				name: e.name,
				where: at(e.file, e.line),
				reachesHome: reachedComponents.includes(op.home),
				components: reachedComponents,
				writes: reachedWrites,
				unresolved: [
					...new Set(e.reach.unresolvedCalls.map((u) => u.name)),
				].sort(),
				httpHops: e.reach.httpHops ?? [],
			};
		});
		if (eps.length === 0 && !op.planned)
			add("op.no-entry-point", op.id, `No entry point serves ${op.id}.`);
		// The mission copilot gets every agent tool on top of its own.
		const seenActors = new Set(
			rows.flatMap((r) =>
				r.actor === "AG" && r.kind === "tool" ? ["AG", "MC"] : [r.actor],
			),
		);
		for (const a of op.actors) {
			const has = a === "ADM" ? seenActors.has("OP") : seenActors.has(a);
			if (!has && eps.length > 0)
				add(
					"op.actor-missing",
					op.id,
					`${a} is an actor of ${op.id}, but no entry point serves ${a}.`,
				);
		}
		for (const a of new Set(rows.map((r) => r.actor)))
			if (!op.actors.includes(a) && !(a === "OP" && op.actors.includes("ADM")))
				add(
					"op.actor-extra",
					op.id,
					`An entry point serves ${op.id} for ${a}, which the catalog does not list as its actor.`,
					rows.filter((r) => r.actor === a).map((r) => r.where),
				);
		const astray = rows.filter((r) => !r.reachesHome);
		if (astray.length > 0)
			add(
				"op.home-not-reached",
				op.id,
				astray.length === rows.length
					? `None of the ${rows.length} entry point(s) of ${op.id} reaches code in its home, ${op.home}: ${astray.map((r) => `${r.kind} ${r.name}`).join("; ")}.`
					: `${astray.length} of ${rows.length} entry points of ${op.id} reach no code in its home, ${op.home}: ${astray.map((r) => `${r.kind} ${r.name}`).join("; ")}.`,
				astray.map((r) => r.where),
				{
					entryPoints: astray.map((r) => ({
						name: `${r.kind} ${r.name}`,
						where: r.where,
						components: r.components,
						unresolved: r.unresolved,
					})),
				},
			);
		if (rows.length > 1) {
			// For each entry point, the writes some other entry point reaches and it does not.
			const all = new Set(rows.flatMap((r) => r.writes));
			const gaps = rows
				.map((r) => ({
					r,
					lacks: [...all].filter((w) => !r.writes.includes(w)),
				}))
				.filter((g) => g.lacks.length > 0);
			if (gaps.length > 0)
				add(
					"op.divergent-writes",
					op.id,
					`Entry points of ${op.id} reach different database writes: ${gaps.map((g) => `${g.r.kind} ${g.r.name} lacks ${g.lacks.length}`).join("; ")}.`,
					gaps.map((g) => g.r.where),
					{
						lacks: gaps.map((g) => ({
							entryPoint: `${g.r.kind} ${g.r.name}`,
							where: g.r.where,
							writes: g.lacks,
						})),
					},
				);
		}
		return {
			id: op.id,
			intent: op.intent,
			home: op.home,
			actors: op.actors,
			planned: !!op.planned,
			entryPoints: rows,
		};
	});

	// ── Data stores ───────────────────────────────────────────────────────
	const storeOf = new Map(b.DATA_STORES.map((d) => [d.collection, d]));
	for (const w of writes) {
		w.component = component(w.file);
		const store = storeOf.get(w.collection);
		if (!store) continue;
		const allowed = new Set([
			store.owner,
			...(store.alsoWrittenBy ?? []).map((x) => x.component),
		]);
		w.ownerOk = allowed.has(w.component);
		if (!w.ownerOk)
			add(
				"store.foreign-writer",
				w.collection,
				`${w.component} writes ${w.collection} (${w.method} in ${w.function}); its owner is ${store.owner}.`,
				[at(w.file, w.line)],
			);
	}

	// ── Status transitions ────────────────────────────────────────────────
	const statusEntities = b.ENTITIES.filter(
		(e) => e.store.kind === "collection" && e.store.statusField,
	);
	const statusModel = new Map(
		statusEntities.map((e) => {
			const stored = (s) => (s.stored === undefined ? s.id : s.stored);
			const values = e.states.map(stored).filter((v) => v !== null);
			const toStored = new Map(e.states.map((s) => [s.id, stored(s)]));
			const allowed = new Set(
				e.transitions.map(
					(t) =>
						`${t.from === null ? "∅" : toStored.get(t.from)}>${toStored.get(t.to)}`,
				),
			);
			return [
				e.store.collection,
				{ entity: e, values, allowed, toStored, made: new Set() },
			];
		}),
	);
	for (const w of writes) {
		const m = statusModel.get(w.collection);
		if (!m || !w.status) continue;
		const to = w.status.to;
		const f = w.status.from;
		let from;
		if (f.op === "none") from = ["∅"];
		else if (f.op === "eq" || f.op === "in") from = f.values;
		else if (f.op === "ne" || f.op === "nin")
			from = m.values.filter((v) => !f.values.includes(v));
		else from = m.values;
		for (const v of [...to, ...(f.values ?? [])])
			if (v !== "?" && !m.values.includes(v))
				add(
					"status.unknown-state",
					m.entity.id,
					`The code uses the ${m.entity.id} status "${v}", which is not a state in the catalog.`,
					[at(w.file, w.line)],
				);
		const undeclared = [];
		for (const a of from)
			for (const t of to) {
				const pair = `${a}>${t}`;
				if (m.allowed.has(pair)) m.made.add(pair);
				else if (t !== "?")
					undeclared.push(`${a === "∅" ? "(new)" : a} → ${t}`);
			}
		w.statusCheck = {
			from,
			to,
			undeclared,
			filterChecksStatus: f.op !== "any" && f.op !== "unknown",
		};
		if (undeclared.length > 0)
			add(
				"status.undeclared-transition",
				m.entity.id,
				`${w.function} (${w.component}) can change a ${m.entity.id} ${undeclared.length === 1 ? "status" : "status in ways"} the catalog does not allow: ${undeclared.join(", ")}.${f.op === "any" ? " Its filter does not check the current status." : ""}`,
				[at(w.file, w.line)],
				{ undeclared },
			);
	}
	for (const [, m] of statusModel)
		for (const pair of m.allowed)
			if (!m.made.has(pair)) {
				const [a, t] = pair.split(">");
				add(
					"status.unseen-transition",
					m.entity.id,
					`No code writes the ${m.entity.id} transition ${a === "∅" ? "(new)" : a} → ${t} that the catalog allows.`,
				);
			}

	// ── Security ──────────────────────────────────────────────────────────
	const security = [];
	if (sarif) {
		for (const run of sarif.runs ?? [])
			for (const r of run.results ?? []) {
				const loc = r.locations?.[0]?.physicalLocation;
				const file = loc?.artifactLocation?.uri ?? "?";
				const line = loc?.region?.startLine ?? 0;
				const invariant =
					RULE_INVARIANT.find(([re]) => re.test(r.ruleId))?.[1] ??
					"sec.unmapped";
				const row = {
					rule: r.ruleId,
					invariant,
					file,
					line,
					component: component(file),
					message: r.message?.text ?? "",
				};
				security.push(row);
				add(
					"sec.result",
					invariant,
					`${r.ruleId}: ${row.message.split("\n")[0]}`,
					[at(file, line)],
					{ rule: r.ruleId },
				);
			}
	}

	// ── Invariants ────────────────────────────────────────────────────────
	const invariants = [
		...b.ENTITIES.flatMap((e) =>
			e.invariants.map((i) => ({ ...i, scope: e.id })),
		),
		...b.PLATFORM_INVARIANTS.map((i) => ({ ...i, scope: "platform" })),
		...b.SECURITY_INVARIANTS.map((i) => ({ ...i, scope: "security" })),
	].map((i) => ({
		id: i.id,
		scope: i.scope,
		text: i.text,
		enforcedBy: i.enforcedBy,
		decidedBy: i.decidedBy ?? null,
		open: i.open ?? null,
		findings: findings.filter((f) => f.about === i.id).length,
	}));
	for (const i of invariants)
		if (i.enforcedBy.length === 0)
			add("inv.unenforced", i.id, `Nothing enforces ${i.id} yet.`);

	return { findings, operations, writes, security, invariants };
}

/** Marks findings whose key was not in the previous run. */
export function markNew(findings, previous) {
	const before = new Set((previous ?? []).map((f) => f.key));
	for (const f of findings) f.new = previous ? !before.has(f.key) : null;
	return findings;
}
