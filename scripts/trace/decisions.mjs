#!/usr/bin/env node
// The reviewers' decisions on the trace's findings, the user's spot checks of
// those decisions, and each reviewer's view of both.
//
//   node scripts/trace/decisions.mjs build <analysis dir> <coverage.json> [--max-bytes N] [--previous <findings.json>]
//     writes findings-<agent>.md for every agent in coverage.json, and
//     catalog-questions.md, from <analysis dir>/findings.json,
//     dispositions.jsonl and spot-checks.jsonl
//
//   node scripts/trace/decisions.mjs about <analysis dir> <file or baseline id> [--all]
//     the findings whose locations or subject match, with every decision and
//     spot check recorded on them; the calling agent's ($AGENT_ID) share
//     unless --all
//
//   node scripts/trace/decisions.mjs dispose <analysis dir> <key> <finding|dismissed|catalog|reopen> <reason…>
//     records what the calling agent ($AGENT_ID) concluded about one finding
//
//   node scripts/trace/decisions.mjs sample <analysis dir> <n> [--seed S]
//     n dismissals not yet spot-checked, chosen at random, for the user to check
//
//   node scripts/trace/decisions.mjs check <analysis dir> <agent> <key> <upheld|wrong> <reason…>
//     records a spot check of that agent's dismissal (by $CHECKED_BY, default "user")
//
// The view is a reference, not a queue: no count of what is left to examine.
// A reviewer's output is the findings and catalog questions it raises; a
// dismissal says the trace is wrong, and stands until a spot check finds
// otherwise, which reopens the finding for that reviewer.
//
// A decision is a claim about the code: its reason must cite the file:line
// that establishes it, and is its own (the same reason for two findings is
// refused). A dismissal or a catalog question must also cite one of the
// places the finding names (subjectLocations).
//
// coverage.json: { "agents": { "<agent id>": ["<kind>", "<kind>:<about prefix>", …] } }
// selects, per agent, the findings in its area: by kind, optionally narrowed
// to the baseline ids starting with a prefix ("inv.unenforced:sec."). An
// optional "since": { "<agent id>": "<ISO time>" } sets aside that agent's
// earlier decisions.

import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DISPOSITIONS = ["finding", "dismissed", "catalog", "reopen"];
const DECISIONS = new Set(["finding", "dismissed", "catalog"]);
const AGAINST_SCAN = new Set(["dismissed", "catalog"]);
export const CHECK_RESULTS = ["upheld", "wrong"];

/** A `path/file.ext:line` citation: what makes a decision checkable. */
const CITATION = /[\w./-]+\.[a-z]{1,5}:\d+/;
const BUILD_SETTINGS = ".decisions-build.json";
const FINDINGS = "findings.json";

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

function readJsonl(dir, name) {
	const path = join(dir, name);
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

/**
 * Where one agent stands on each finding: its latest record, and whether a
 * later spot check found that record wrong.
 * status: "finding" | "catalog" | "dismissed" | "wrong" (a dismissal a spot
 * check refuted) | "unsupported" (recorded without evidence) | "none".
 */
export function standing(f, agent, dispositions, checks) {
	let rec = null;
	for (const d of dispositions)
		if (d.agent === agent && d.key === f.key) rec = d;
	if (!rec || rec.disposition === "reopen") return { status: "none", rec };
	const gap = insufficient(rec, f);
	if (gap) return { status: "unsupported", rec, gap };
	let check = null;
	for (const c of checks)
		if (c.agent === agent && c.key === f.key && c.at >= rec.at) check = c;
	if (rec.disposition === "dismissed" && check?.result === "wrong")
		return { status: "wrong", rec, check };
	return { status: rec.disposition, rec, check };
}

const short = (loc) => loc.replace(/(^|@)packages\//, "$1");
const fileOf = (loc) => short(loc.split("@").pop()).split(/:(?=\d+$)/)[0];
export const line = (f) => {
	const text = f.text.length > 220 ? `${f.text.slice(0, 217)}…` : f.text;
	const where = f.where?.length
		? ` (${f.where.slice(0, 2).map(short).join(", ")}${f.where.length > 2 ? ", …" : ""})`
		: "";
	// For a difference between entry points, what each one does not reach is
	// the substance of the finding.
	const lacks = (f.lacks ?? []).map(
		(l) =>
			`\n    ${l.entryPoint} does not reach: ${l.writes
				.slice(0, 4)
				.map(short)
				.join(", ")}${l.writes.length > 4 ? ", …" : ""}`,
	);
	return `- \`${f.key}\` ${f.kind} · ${f.about}: ${text}${where}${lacks.join("")}`;
};

/** The files a finding touches, for looking findings up by file. */
function filesOf(f) {
	return new Set(
		[...(f.where ?? []), ...subjectLocations(f)].map(fileOf).filter(Boolean),
	);
}

/**
 * One agent's view of its share of the findings, at most `maxBytes` long:
 * spot checks that found its dismissals wrong, what is new, where the
 * findings are, and its record.
 */
export function renderView(
	agent,
	meta,
	findings,
	dispositions,
	checks,
	maxBytes,
) {
	const st = new Map(
		findings.map((f) => [f.key, standing(f, agent, dispositions, checks)]),
	);
	const count = (s) =>
		findings.filter((f) => st.get(f.key).status === s).length;
	const wrong = findings.filter((f) => st.get(f.key).status === "wrong");
	const fresh = findings.filter(
		(f) => f.new && st.get(f.key).status === "none",
	);
	const byFile = new Map();
	for (const f of findings)
		for (const file of filesOf(f))
			byFile.set(file, (byFile.get(file) ?? 0) + 1);
	const files = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
	const checked = findings.filter((f) => {
		const s = st.get(f.key);
		return s.check && (s.status === "dismissed" || s.status === "wrong");
	}).length;

	const head = [
		`# Trace findings: ${agent}`,
		"",
		`Places in your area where the code may not do what the catalog intends (scan of commit ${meta.commit} at ${meta.time}). A finding is a question to answer when you review the code it touches, not an item to clear: one nobody has examined costs nothing, a wrong conclusion does. Findings on a file, with what has been decided about them:`,
		'`node <your clone>/scripts/trace/decisions.mjs about "$SHARED_DIR/analysis" <file or baseline id>`',
		"",
	].join("\n");
	const foot = [
		"",
		`Your record on this scan: ${count("finding")} findings raised, ${count("catalog")} catalog questions; ${count("dismissed") + wrong.length} dismissed, ${checked} of them spot-checked by the user, ${wrong.length} found wrong.`,
	].join("\n");

	const sections = [
		[
			"## Dismissals a spot check found wrong",
			wrong.map((f) => {
				const s = st.get(f.key);
				return `${line(f)}\n    The user: ${s.check.reason}`;
			}),
		],
		[
			"## New since the last scan (look at them with the change that introduced them)",
			fresh.map(line),
		],
		[
			`## Where your ${findings.length} findings are (top files)`,
			files.map(([file, n]) => `- ${file}: ${n}`),
		],
	];
	let text = head;
	const tail = [];
	for (const [title, rows] of sections) {
		if (rows.length === 0) continue;
		text += `\n${title}\n\n`;
		let shown = 0;
		for (const r of rows) {
			if (Buffer.byteLength(`${text}${r}\n${foot}`) > maxBytes - 160) break;
			text += `${r}\n`;
			shown++;
		}
		if (shown < rows.length)
			tail.push(`${rows.length - shown} more under "${title.slice(3)}".`);
	}
	if (tail.length) text += `\n${tail.join(" ")} See \`about\`.\n`;
	return `${text}${foot}\n`;
}

/**
 * The findings matching `query` (a file path fragment or a baseline id),
 * with every agent's latest decision and the spot checks on each.
 */
export function about(dir, query, agent, coverage = null) {
	const { meta, findings } = readFindings(dir);
	const dispositions = readJsonl(dir, "dispositions.jsonl");
	const checks = readJsonl(dir, "spot-checks.jsonl");
	const mine = coverage
		? findings.filter((f) => covers(coverage, f))
		: findings;
	const hits = mine.filter(
		(f) =>
			f.about === query ||
			f.about.startsWith(`${query}.`) ||
			[...filesOf(f)].some((file) => file.includes(query)),
	);
	const out = [
		`${hits.length} finding(s) on "${query}"${coverage ? ` in ${agent}'s area` : ""} (scan of ${meta.commit}).`,
	];
	for (const f of hits) {
		out.push(line(f));
		const agents = [
			...new Set(
				dispositions.filter((d) => d.key === f.key).map((d) => d.agent),
			),
		];
		for (const a of agents) {
			const s = standing(f, a, dispositions, checks);
			if (!s.rec) continue;
			out.push(
				`    ${a}: ${s.rec.disposition} (${s.rec.at.slice(0, 10)}${s.gap ? `, does not count: ${s.gap}` : ""}): ${s.rec.reason}`,
			);
			if (s.check)
				out.push(
					`    spot check: ${s.check.result} by ${s.check.by}: ${s.check.reason}`,
				);
		}
	}
	return out.join("\n");
}

/**
 * Marks as new the findings whose key was not in `previousPath`: new since
 * the scan the reader last saw, not since the previous push.
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
		(d) => d.disposition === "catalog" && !insufficient(d, byKey.get(d.key)),
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

function readFindings(dir) {
	return JSON.parse(readFileSync(join(dir, FINDINGS), "utf8"));
}

function readCoverage(path) {
	const { agents, since = {} } = JSON.parse(readFileSync(path, "utf8"));
	return { agents, since };
}

export function build(dir, coveragePath, maxBytes = 6000, previousPath = null) {
	const { meta, findings: all } = readFindings(dir);
	const findings = markNewSince(all, previousPath);
	const { agents: coverage, since } = readCoverage(coveragePath);
	// An agent's decisions before its `since` date are set aside.
	const dispositions = readJsonl(dir, "dispositions.jsonl").filter(
		(d) => !since[d.agent] || d.at >= since[d.agent],
	);
	const checks = readJsonl(dir, "spot-checks.jsonl");
	const written = [];
	for (const [agent, selectors] of Object.entries(coverage)) {
		const mine = findings.filter((f) => covers(selectors, f));
		writeFileSync(
			join(dir, `findings-${agent}.md`),
			renderView(agent, meta, mine, dispositions, checks, maxBytes),
		);
		const n = (s) =>
			mine.filter((f) => standing(f, agent, dispositions, checks).status === s)
				.length;
		written.push(
			`${agent}: ${mine.length} findings in its area; ${n("finding")} raised, ${n("catalog")} catalog, ${n("dismissed")} dismissed, ${n("wrong")} found wrong`,
		);
	}
	writeFileSync(
		join(dir, "catalog-questions.md"),
		renderCatalogQuestions(meta, findings, dispositions),
	);
	// What dispose and check need to rebuild the views the same way.
	writeFileSync(
		join(dir, BUILD_SETTINGS),
		JSON.stringify({ coveragePath, maxBytes, previousPath }),
	);
	return written;
}

function rebuild(dir) {
	const settings = join(dir, BUILD_SETTINGS);
	if (!existsSync(settings)) return;
	const s = JSON.parse(readFileSync(settings, "utf8"));
	build(dir, s.coveragePath, s.maxBytes, s.previousPath);
}

function findingByKey(dir, key) {
	if (!/^[0-9a-f]{12}$/.test(key))
		throw new Error(`"${key}" is not a finding key`);
	const finding = readFindings(dir).findings.find((f) => f.key === key);
	if (!finding) throw new Error(`no finding ${key} in the last scan`);
	return finding;
}

export function dispose(dir, key, disposition, reason, agent) {
	if (!DISPOSITIONS.includes(disposition))
		throw new Error(`disposition must be one of ${DISPOSITIONS.join(", ")}`);
	if (!agent) throw new Error("AGENT_ID is not set");
	const why = reason.trim();
	if (!why) throw new Error("give a reason");
	const finding = findingByKey(dir, key);
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
		const reused = readJsonl(dir, "dispositions.jsonl").find(
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
	rebuild(dir);
	return record;
}

/** A small seeded generator, so a sample can be drawn again. */
function seeded(seed) {
	let h = 1779033703 ^ seed.length;
	for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
	return () => {
		h = Math.imul(h ^ (h >>> 16), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		return ((h ^= h >>> 16) >>> 0) / 4294967296;
	};
}

/** `n` standing dismissals no spot check has looked at yet, at random. */
export function sample(dir, n, seed = new Date().toISOString()) {
	const { findings } = readFindings(dir);
	const dispositions = readJsonl(dir, "dispositions.jsonl");
	const checks = readJsonl(dir, "spot-checks.jsonl");
	const agents = [...new Set(dispositions.map((d) => d.agent))];
	const pool = [];
	for (const f of findings)
		for (const agent of agents) {
			const s = standing(f, agent, dispositions, checks);
			if (s.status === "dismissed" && !s.check) pool.push({ f, agent, s });
		}
	const rand = seeded(seed);
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	return pool.slice(0, n).map(({ f, agent, s }) => ({
		agent,
		key: f.key,
		finding: line(f),
		reason: s.rec.reason,
		at: s.rec.at,
	}));
}

export function check(dir, agent, key, result, reason, by = "user") {
	if (!CHECK_RESULTS.includes(result))
		throw new Error(`result must be one of ${CHECK_RESULTS.join(", ")}`);
	const why = reason.trim();
	if (!CITATION.test(why))
		throw new Error(
			"a spot check is a claim about the code: cite the file:line",
		);
	const f = findingByKey(dir, key);
	const s = standing(
		f,
		agent,
		readJsonl(dir, "dispositions.jsonl"),
		readJsonl(dir, "spot-checks.jsonl"),
	);
	if (s.status !== "dismissed" && s.status !== "wrong")
		throw new Error(`${agent} has no standing dismissal of ${key}`);
	const record = {
		key,
		agent,
		result,
		reason: why.slice(0, 500),
		by,
		at: new Date().toISOString(),
	};
	appendFileSync(join(dir, "spot-checks.jsonl"), `${JSON.stringify(record)}\n`);
	rebuild(dir);
	return record;
}

function coverageOf(dir, agent) {
	const settings = join(dir, BUILD_SETTINGS);
	if (!existsSync(settings)) return null;
	const { coveragePath } = JSON.parse(readFileSync(settings, "utf8"));
	return readCoverage(coveragePath).agents[agent] ?? null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [cmd, ...a] = process.argv.slice(2);
	const flag = (name) => {
		const i = a.indexOf(name);
		return i >= 0 ? a[i + 1] : undefined;
	};
	try {
		if (cmd === "build") {
			const max = flag("--max-bytes");
			console.log(
				build(
					a[0],
					a[1],
					max ? Number(max) : undefined,
					flag("--previous") ?? null,
				).join("\n"),
			);
		} else if (cmd === "about") {
			const agent = process.env.AGENT_ID;
			const coverage = a.includes("--all") ? null : coverageOf(a[0], agent);
			console.log(about(a[0], a[1], agent, coverage));
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
		} else if (cmd === "sample") {
			for (const s of sample(a[0], Number(a[1]), flag("--seed")))
				console.log(
					`${s.agent} ${s.key} (${s.at.slice(0, 16)})\n${s.finding}\n    dismissed: ${s.reason}\n`,
				);
		} else if (cmd === "check") {
			const [dir, agent, key, result, ...reason] = a;
			console.log(
				JSON.stringify(
					check(
						dir,
						agent,
						key,
						result,
						reason.join(" "),
						process.env.CHECKED_BY || "user",
					),
				),
			);
		} else {
			throw new Error(
				"usage: decisions.mjs build <dir> <coverage.json> [--max-bytes N] [--previous <findings.json>] | about <dir> <file|id> [--all] | dispose <dir> <key> <disposition> <reason> | sample <dir> <n> [--seed S] | check <dir> <agent> <key> upheld|wrong <reason>",
			);
		}
	} catch (e) {
		console.error(`[decisions] ${e.message}`);
		process.exit(2);
	}
}
