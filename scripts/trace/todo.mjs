#!/usr/bin/env node
// Per-reviewer to-do lists from the trace's findings, and their dispositions.
//
//   node scripts/trace/todo.mjs build <analysis dir> <coverage.json> [--max-bytes N] [--previous <todo.json>]
//     writes todo-<agent>.md into <analysis dir> for every agent in coverage.json,
//     from <analysis dir>/todo.json and <analysis dir>/dispositions.jsonl
//
//   node scripts/trace/todo.mjs dispose <analysis dir> <key> <finding|dismissed|deferred|reopen> <reason…>
//     records what the calling agent ($AGENT_ID) decided about one finding, and
//     rebuilds that agent's to-do. A finding or a dismissal is a claim about the
//     code: its reason must cite the file:line that establishes it, and is its
//     own (the same reason for two findings is refused). A deferred finding stays
//     on the to-do, under "Deferred". The latest record per key wins.
//
// coverage.json: { "agents": { "<agent id>": ["<kind>", "<kind>:<about prefix>", …] } }
// selects, per agent, the findings it owns: by kind, optionally narrowed to
// the baseline ids starting with a prefix ("inv.unenforced:sec.").

import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DISPOSITIONS = ["finding", "dismissed", "deferred", "reopen"];

/** A `path/file.ext:line` citation: what makes a decision checkable. */
const CITATION = /[\w./-]+\.[a-z]{1,5}:\d+/;
const BUILD_SETTINGS = ".todo-build.json";

/** Does a record decide its finding (take it off the open list)? */
export function decides(d) {
	return (
		(d.disposition === "finding" || d.disposition === "dismissed") &&
		CITATION.test(d.reason)
	);
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

const line = (f) => {
	const text = f.text.length > 220 ? `${f.text.slice(0, 217)}…` : f.text;
	const where = f.where?.length
		? ` (${f.where.slice(0, 2).join(", ")}${f.where.length > 2 ? ", …" : ""})`
		: "";
	return `- \`${f.key}\` ${f.kind} · ${f.about}: ${text}${where}`;
};

/**
 * One agent's to-do, at most `maxBytes` long. `latest` is the agent's latest
 * record per finding key; only a decision with evidence takes a finding off.
 */
export function renderTodo(agent, meta, findings, latest, maxBytes) {
	const rec = (f) => latest.get(f.key);
	const decided = findings.filter((f) => rec(f) && decides(rec(f)));
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
		`Scan of commit ${meta.commit} at ${meta.time}. Full reports in shared/analysis/: index.md, operations.md, writes.md, invariants.md, components.html.`,
		`Open: ${open.length} (new since the last scan: ${fresh.length}); deferred: ${deferred.length}; decided: ${decided.length}.`,
		`By kind: ${
			Object.entries(byKind)
				.map(([k, n]) => `${k} ${n}`)
				.join(", ") || "none"
		}.`,
		"",
		"A finding is evidence to check, not a verdict. Verify each one in the code, then record what you decided; a finding or a dismissal cites the file:line that establishes it:",
		'node <your clone>/scripts/trace/todo.mjs dispose "$SHARED_DIR/analysis" <key> finding|dismissed|deferred|reopen "<reason with file:line>"',
		"",
	];
	const note = (f) => {
		const r = rec(f);
		if (!r || decides(r) || r.disposition === "deferred") return "";
		return r.disposition === "reopen"
			? " [reopened]"
			: ` [your "${r.disposition}" cites no file:line, so it does not count]`;
	};
	const tail = [];
	const sections = [
		["## New since the last scan", fresh],
		["## Other open findings", rest],
		["## Deferred", deferred],
	];
	let text = head.join("\n");
	for (const [title, list] of sections) {
		if (list.length === 0) continue;
		text += `\n${title}\n\n`;
		let shown = 0;
		for (const f of list) {
			const l = `${line(f)}${note(f)}\n`;
			if (Buffer.byteLength(text + l) > maxBytes - 200) break;
			text += l;
			shown++;
		}
		if (shown < list.length)
			tail.push(
				`${list.length - shown} more under "${title.slice(3)}": see todo.json.`,
			);
	}
	if (tail.length) text += `\n${tail.join(" ")}\n`;
	return text;
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

export function build(dir, coveragePath, maxBytes = 6000, previousPath = null) {
	const { meta, findings: all } = JSON.parse(
		readFileSync(join(dir, "todo.json"), "utf8"),
	);
	const findings = markNewSince(all, previousPath);
	const coverage = JSON.parse(readFileSync(coveragePath, "utf8")).agents;
	const dispositions = readDispositions(dir);
	const written = [];
	for (const [agent, selectors] of Object.entries(coverage)) {
		const mine = findings.filter((f) => covers(selectors, f));
		const latest = latestByKey(dispositions, agent);
		writeFileSync(
			join(dir, `todo-${agent}.md`),
			renderTodo(agent, meta, mine, latest, maxBytes),
		);
		const decided = mine.filter(
			(f) => latest.has(f.key) && decides(latest.get(f.key)),
		).length;
		written.push(`${agent}: ${mine.length - decided} open or deferred`);
	}
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
	if (!findings.some((f) => f.key === key))
		throw new Error(`no finding ${key} in the last scan`);
	if (disposition === "finding" || disposition === "dismissed") {
		if (!CITATION.test(why))
			throw new Error(
				`a ${disposition} is a claim about the code: cite the file:line you read that establishes it for this finding`,
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
