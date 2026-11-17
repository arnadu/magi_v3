#!/usr/bin/env node
// Per-reviewer to-do lists from the trace's findings, and their dispositions.
//
//   node scripts/trace/todo.mjs build <analysis dir> <coverage.json> [--max-bytes N] [--previous <todo.json>]
//     writes todo-<agent>.md into <analysis dir> for every agent in coverage.json,
//     from <analysis dir>/todo.json and <analysis dir>/dispositions.jsonl
//
//   node scripts/trace/todo.mjs dispose <analysis dir> <key> <finding|dismissed|catalog|deferred|reopen> <reason…>
//     records what the calling agent ($AGENT_ID) decided about one finding, and
//     rebuilds that agent's to-do. A finding or a dismissal is a claim about the
//     code: its reason must cite the file:line that establishes it, and is its
//     own (the same reason for two findings is refused). A dismissal must also
//     cite one of the places the finding names (subjectLocations). "catalog"
//     says the code is right and the catalog is not: it is held to the same
//     evidence as a dismissal and listed in catalog-questions.md for the user. A deferred finding stays
//     on the to-do, under "Deferred". The latest record per key wins.
//
// coverage.json: { "agents": { "<agent id>": ["<kind>", "<kind>:<about prefix>", …] } }
// selects, per agent, the findings it owns: by kind, optionally narrowed to
// the baseline ids starting with a prefix ("inv.unenforced:sec."). An optional
// "since": { "<agent id>": "<ISO time>" } sets aside that agent's earlier decisions.

import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DISPOSITIONS = [
	"finding",
	"dismissed",
	"catalog",
	"deferred",
	"reopen",
];
const DECISIONS = new Set(["finding", "dismissed", "catalog"]);
const AGAINST_SCAN = new Set(["dismissed", "catalog"]);

/** A `path/file.ext:line` citation: what makes a decision checkable. */
const CITATION = /[\w./-]+\.[a-z]{1,5}:\d+/;
const BUILD_SETTINGS = ".todo-build.json";

/**
 * The places a finding is about, which a dismissal must address: for a
 * difference between entry points, the writes some of them do not reach;
 * otherwise where the finding points.
 */
export function subjectLocations(f) {
	if (f.lacks?.length)
		return f.lacks.flatMap((l) => l.writes.map((w) => w.split("@").pop()));
	return f.where ?? [];
}

const NEAR_LINES = 5;
function citesOneOf(reason, locations) {
	const cited = [...reason.matchAll(new RegExp(CITATION, "g"))].map((m) => {
		const [file, line] = m[0].split(/:(?=\d+$)/);
		return { file, line: Number(line) };
	});
	return locations.some((loc) => {
		const [file, line] = loc.split(/:(?=\d+$)/);
		return cited.some(
			(c) =>
				(file.endsWith(c.file) || c.file.endsWith(file)) &&
				Math.abs(c.line - Number(line)) <= NEAR_LINES,
		);
	});
}

/** Why a record does not decide finding `f`, or null when it does. */
export function insufficient(d, f) {
	if (!DECISIONS.has(d.disposition)) return "not a decision";
	if (!CITATION.test(d.reason)) return "cites no file:line";
	const subject = subjectLocations(f);
	if (
		AGAINST_SCAN.has(d.disposition) &&
		subject.length &&
		!citesOneOf(d.reason, subject)
	)
		return `does not address what the finding names (${subject.slice(0, 3).join(", ")}${subject.length > 3 ? ", …" : ""})`;
	return null;
}

/** Does a record decide its finding (take it off the open list)? */
export function decides(d, f) {
	return insufficient(d, f) === null;
}

/** One agent's latest record per finding key. */
function latestByKey(dispositions, agent) {
	const m = new Map();
	for (const d of dispositions) if (d.agent === agent) m.set(d.key, d);
	return m;
}

function readDispositions(dir) {
	const path = join(dir, "dispositions.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.flatMap((l) => {
			try {
				return [JSON.parse(l)];
			} catch {
				return [];
			}
		});
}

/** Does finding `f` belong to an agent whose coverage is `selectors`? */
export function covers(selectors, f) {
	return selectors.some((s) => {
		const [kind, prefix] = s.split(":");
		return f.kind === kind && (!prefix || f.about.startsWith(prefix));
	});
}

const short = (loc) => loc.replace(/(^|@)packages\//, "$1");
const line = (f) => {
	const text = f.text.length > 220 ? `${f.text.slice(0, 217)}…` : f.text;
	const where = f.where?.length
		? ` (${f.where.slice(0, 2).map(short).join(", ")}${f.where.length > 2 ? ", …" : ""})`
		: "";
	// For a difference between entry points, what each one does not reach is
	// the substance of the finding: shown here, not only in todo.json.
	const lacks = (f.lacks ?? []).map(
		(l) =>
			`\n    ${l.entryPoint} does not reach: ${l.writes
				.slice(0, 4)
				.map(short)
				.join(", ")}${l.writes.length > 4 ? ", …" : ""}`,
	);
	return `- \`${f.key}\` ${f.kind} · ${f.about}: ${text}${where}${lacks.join("")}`;
};

/**
 * One agent's to-do, at most `maxBytes` long. `latest` is the agent's latest
 * record per finding key; only a decision with evidence takes a finding off.
 */
export function renderTodo(agent, meta, findings, latest, maxBytes) {
	const rec = (f) => latest.get(f.key);
	const decided = findings.filter((f) => rec(f) && decides(rec(f), f));
	const deferred = findings.filter((f) => rec(f)?.disposition === "deferred");
	const open = findings.filter(
		(f) => !decided.includes(f) && !deferred.includes(f),
	);
	const fresh = open.filter((f) => f.new);
	const rest = open.filter((f) => !f.new);
	const byKind = {};
	for (const f of open) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
	const head = [
		`# Scan to-do: ${agent}`,
		"",
		`Places where the code may not do what the catalog intends (scan of commit ${meta.commit} at ${meta.time}). For each one you examine: find out whether it is so, and what could go wrong if it is.`,
		"",
	];
	const foot = [
		"",
		`Not yet examined: ${open.length} (new since the last scan: ${fresh.length}). Deferred: ${deferred.length}. Concluded: ${decided.length}. By kind: ${
			Object.entries(byKind)
				.map(([k, n]) => `${k} ${n}`)
				.join(", ") || "none"
		}.`,
		"Details of each finding: todo.json and the reports in shared/analysis/. Record a conclusion with:",
		'node <your clone>/scripts/trace/todo.mjs dispose "$SHARED_DIR/analysis" <key> finding|dismissed|catalog|deferred|reopen "<what you found, with file:line>"',
	].join("\n");
	const note = (f) => {
		const r = rec(f);
		if (!r || r.disposition === "deferred" || decides(r, f)) return "";
		return r.disposition === "reopen"
			? " [reopened]"
			: ` [your "${r.disposition}" ${insufficient(r, f)}, so it does not count]`;
	};
	const tail = [];
	const sections = [
		["## New since the last scan", fresh],
		["## To examine", rest],
		["## Deferred", deferred],
	];
	let text = head.join("\n");
	for (const [title, list] of sections) {
		if (list.length === 0) continue;
		text += `\n${title}\n\n`;
		let shown = 0;
		for (const f of list) {
			const l = `${line(f)}${note(f)}\n`;
			if (Buffer.byteLength(text + l + foot) > maxBytes - 120) break;
			text += l;
			shown++;
		}
		if (shown < list.length)
			tail.push(
				`${list.length - shown} more under "${title.slice(3)}": see todo.json.`,
			);
	}
	if (tail.length) text += `\n${tail.join(" ")}\n`;
	return `${text}${foot}\n`;
}

/**
 * Marks as new the findings whose key was not in `previousPath`'s todo.json:
 * new since the scan the reader last saw, not since the previous push.
 */
function markNewSince(findings, previousPath) {
	if (!previousPath || !existsSync(previousPath)) return findings;
	const before = new Set(
		JSON.parse(readFileSync(previousPath, "utf8")).findings.map((f) => f.key),
	);
	return findings.map((f) => ({ ...f, new: !before.has(f.key) }));
}

/**
 * The reviewers' claims that the catalog, not the code, is wrong: questions
 * for the product owner, who decides every catalog change.
 */
export function renderCatalogQuestions(meta, findings, dispositions) {
	const byKey = new Map(findings.map((f) => [f.key, f]));
	const latest = new Map();
	for (const d of dispositions) latest.set(`${d.agent} ${d.key}`, d);
	const rows = (pick) =>
		[...latest.values()]
			.filter((d) => byKey.has(d.key) && pick(d))
			.map((d) => {
				const f = byKey.get(d.key);
				return `- \`${f.about}\` (${f.kind}, \`${d.key}\`, ${d.agent}, ${d.at.slice(0, 10)}): ${d.reason}`;
			});
	const asked = rows(
		(d) => d.disposition === "catalog" && decides(d, byKey.get(d.key)),
	);
	const mentioned = rows(
		(d) => d.disposition === "dismissed" && /catalog/i.test(d.reason),
	);
	return [
		"# Questions about the catalog",
		"",
		`From the reviewers' decisions on the scan of commit ${meta.commit}. Each says the code is right and the baseline catalog is not; the product owner decides every catalog change.`,
		"",
		"## Raised as catalog questions",
		"",
		...(asked.length ? asked : ["None."]),
		"",
		"## Dismissals whose reason mentions the catalog",
		"",
		"Recorded as dismissals, so possibly the same kind of question.",
		"",
		...(mentioned.length ? mentioned : ["None."]),
		"",
	].join("\n");
}

export function build(dir, coveragePath, maxBytes = 6000, previousPath = null) {
	const { meta, findings: all } = JSON.parse(
		readFileSync(join(dir, "todo.json"), "utf8"),
	);
	const findings = markNewSince(all, previousPath);
	const { agents: coverage, since = {} } = JSON.parse(
		readFileSync(coveragePath, "utf8"),
	);
	// An agent's decisions before its `since` date are set aside: they no
	// longer count, so its findings come back to be examined afresh.
	const dispositions = readDispositions(dir).filter(
		(d) => !since[d.agent] || d.at >= since[d.agent],
	);
	const written = [];
	for (const [agent, selectors] of Object.entries(coverage)) {
		const mine = findings.filter((f) => covers(selectors, f));
		const latest = latestByKey(dispositions, agent);
		writeFileSync(
			join(dir, `todo-${agent}.md`),
			renderTodo(agent, meta, mine, latest, maxBytes),
		);
		const decided = mine.filter(
			(f) => latest.has(f.key) && decides(latest.get(f.key), f),
		).length;
		written.push(`${agent}: ${mine.length - decided} open or deferred`);
	}
	writeFileSync(
		join(dir, "catalog-questions.md"),
		renderCatalogQuestions(meta, findings, dispositions),
	);
	// What dispose needs to rebuild the to-dos the same way.
	writeFileSync(
		join(dir, BUILD_SETTINGS),
		JSON.stringify({ coveragePath, maxBytes, previousPath }),
	);
	return written;
}

export function dispose(dir, key, disposition, reason, agent) {
	if (!DISPOSITIONS.includes(disposition))
		throw new Error(`disposition must be one of ${DISPOSITIONS.join(", ")}`);
	if (!/^[0-9a-f]{12}$/.test(key))
		throw new Error(`"${key}" is not a finding key`);
	if (!agent) throw new Error("AGENT_ID is not set");
	const why = reason.trim();
	if (!why) throw new Error("give a reason");
	const { findings } = JSON.parse(readFileSync(join(dir, "todo.json"), "utf8"));
	const finding = findings.find((f) => f.key === key);
	if (!finding) throw new Error(`no finding ${key} in the last scan`);
	if (DECISIONS.has(disposition)) {
		if (!CITATION.test(why))
			throw new Error(
				`a ${disposition} is a claim about the code: cite the file:line you read that establishes it for this finding`,
			);
		const gap = insufficient({ disposition, reason: why }, finding);
		if (gap)
			throw new Error(
				`this ${disposition} ${gap}: say what you found at those places`,
			);
		const reused = readDispositions(dir).find(
			(d) => d.agent === agent && d.key !== key && d.reason === why,
		);
		if (reused)
			throw new Error(
				`the same reason was given for finding ${reused.key}: verify this finding on its own and say what you found for it`,
			);
	}
	const record = {
		key,
		agent,
		disposition,
		reason: why.slice(0, 500),
		at: new Date().toISOString(),
	};
	appendFileSync(
		join(dir, "dispositions.jsonl"),
		`${JSON.stringify(record)}\n`,
	);
	const settings = join(dir, BUILD_SETTINGS);
	if (existsSync(settings)) {
		const s = JSON.parse(readFileSync(settings, "utf8"));
		build(dir, s.coveragePath, s.maxBytes, s.previousPath);
	}
	return record;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [cmd, ...a] = process.argv.slice(2);
	try {
		if (cmd === "build") {
			const i = a.indexOf("--max-bytes");
			const p = a.indexOf("--previous");
			console.log(
				build(
					a[0],
					a[1],
					i >= 0 ? Number(a[i + 1]) : undefined,
					p >= 0 ? a[p + 1] : null,
				).join("\n"),
			);
		} else if (cmd === "dispose") {
			const [dir, key, disposition, ...reason] = a;
			console.log(
				JSON.stringify(
					dispose(
						dir,
						key,
						disposition,
						reason.join(" "),
						process.env.AGENT_ID,
					),
				),
			);
		} else {
			throw new Error(
				"usage: todo.mjs build <dir> <coverage.json> [--max-bytes N] [--previous <todo.json>] | dispose <dir> <key> <disposition> <reason>",
			);
		}
	} catch (e) {
		console.error(`[todo] ${e.message}`);
		process.exit(2);
	}
}
