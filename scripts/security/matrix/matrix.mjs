#!/usr/bin/env node
/**
 * The attack matrix as a document (security assurance plan, part 2): every entry point against
 * every attack class that applies to it, each cell covered (by a named test), open, or not
 * applicable (with the reason). Results are not shown: the repository is public, and a failing
 * cell is an unfixed vulnerability (failures are in code scanning).
 *
 * Rows: the four HTTP surfaces from docs/api/*.openapi.json (with their authentication); agent
 * tools, request folders, copilot actions and timers from the trace's entry points (a copy is kept
 * in docs/security/entry-points.json, refreshed by --write after `npm run trace`); and two platform
 * rows for what no entry point covers (an agent's OS user, the machine on the network, the
 * daemon's sudo helpers).
 *
 *   node scripts/security/matrix/matrix.mjs --write   # refresh the copy and docs/security/attack-matrix.md
 *
 * attack-matrix.unit.test.ts (control plane) renders it again and compares, and checks that every
 * test the matrix names exists and names the cell.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HTTP_TEST =
	"packages/control-plane/tests/attack-matrix-http.unit.test.ts";
const SANDBOX = "scripts/security/sandbox/sandbox.py";

/**
 * Attack classes. `applies(row)` says whether a row gets the cell; `covered(row)` returns the
 * test and the name it carries there (an `it()` title fragment or a sandbox cell id), or null;
 * `na(row)` returns the reason a cell does not apply, when it is listed but cannot be attacked.
 */
export const CLASSES = [
	// ── Control plane ──────────────────────────────────────────────────────────
	{
		id: "no-credential",
		invariant: "sec.authenticated",
		attack: "the route without any credential",
		applies: (r) => r.surface === "control-plane" && r.auth !== "monitor-token",
		covered: (r) =>
			r.auth === "operator" ? { test: HTTP_TEST, name: "no-credential" } : null,
		na: (r) =>
			r.auth === "public"
				? "public by design (listed with its reason in api-surface.unit.test.ts)"
				: null,
	},
	{
		id: "bad-mission-token",
		invariant: "sec.authenticated",
		attack: "another or no mission token",
		applies: (r) => r.surface === "control-plane" && r.auth === "monitor-token",
		covered: () => ({ test: HTTP_TEST, name: "bad-mission-token" }),
	},
	{
		id: "other-tenant",
		invariant: "sec.tenant-scoped",
		attack: "another tenant names this tenant's mission or app",
		applies: (r) =>
			r.surface === "control-plane" &&
			r.auth === "operator" &&
			/^\/api\/missions\/\{id\}|^\/missions\/\{id\}|^\/api\/apps\//.test(
				r.path,
			),
		covered: (r) =>
			r.method === "DELETE" && r.path === "/api/missions/{id}"
				? null
				: { test: HTTP_TEST, name: "other-tenant" },
		na: (r) =>
			r.method === "DELETE" && r.path === "/api/missions/{id}"
				? "refused to everyone, the owner included (destruction disabled)"
				: null,
	},
	{
		id: "field-injection",
		invariant: "sec.input-validated",
		attack: "operator or field names where a value is expected",
		applies: (r) =>
			r.surface === "control-plane" &&
			["POST", "PUT", "PATCH"].includes(r.method) &&
			r.auth !== "public",
		covered: () => null,
	},
	// ── Monitor server (a mission machine's port 4000) ─────────────────────────
	{
		id: "no-monitor-token",
		invariant: "sec.authenticated",
		attack: "the route without the mission's monitor token",
		applies: (r) => r.surface === "monitor" && r.auth === "monitor",
		covered: () => ({ test: SANDBOX, name: "MON-1" }),
	},
	{
		id: "path-escape",
		invariant: "sec.contained-paths",
		attack: "a path or symlink that leaves the allowed folder",
		applies: (r) =>
			r.surface === "monitor" && /^\/(files|download|upload)/.test(r.path),
		covered: (r) =>
			r.method === "GET" && r.path === "/files/shared"
				? { test: SANDBOX, name: "MON-2" }
				: null,
	},
	{
		id: "apps-token",
		invariant: "sec.authenticated",
		attack: "the app hop without the apps token, or with another mission's",
		applies: (r) => r.surface === "monitor" && r.auth === "apps",
		covered: () => null,
	},
	// ── Tool API (port 4001, background jobs) ──────────────────────────────────
	{
		id: "no-job-token",
		invariant: "sec.authenticated",
		attack: "the tool without a job token",
		applies: (r) => r.surface === "tool-api",
		covered: (r) =>
			r.path === "/tools/post-message"
				? { test: SANDBOX, name: "TOOL-1" }
				: null,
	},
	{
		id: "other-agent-token",
		invariant: "sec.least-privilege",
		attack: "one agent's job token used to act as another agent",
		applies: (r) => r.surface === "tool-api",
		covered: () => ({ test: SANDBOX, name: "TOOL-2" }),
	},
	{
		id: "token-after-exit",
		invariant: "sec.authenticated",
		attack: "a job's token used after the job has exited",
		applies: (r) => r.surface === "tool-api",
		covered: () => ({ test: SANDBOX, name: "TOOL-3" }),
	},
	// ── Apps host ──────────────────────────────────────────────────────────────
	{
		id: "forged-or-replayed-ticket",
		invariant: "sec.authenticated",
		attack: "a forged, expired or reused ticket, or no app session",
		applies: (r) => r.surface === "apps-host",
		covered: () => null,
		na: (r) =>
			r.path === "/healthz"
				? "public liveness probe: no state, no app reached"
				: null,
	},
	// ── Agent tools ────────────────────────────────────────────────────────────
	{
		id: "path-escape",
		invariant: "sec.contained-paths",
		attack: "a path or symlink that leaves the agent's allowed folders",
		applies: (r) => r.surface === "tool" && r.actor !== "CC",
		covered: () => null,
	},
	{
		id: "other-tenant",
		invariant: "sec.tenant-scoped",
		attack: "the control-plane copilot names another user's mission",
		applies: (r) => r.surface === "tool" && r.actor === "CC",
		covered: () => null,
	},
	// ── Request folders ────────────────────────────────────────────────────────
	{
		id: "spoofed-author",
		invariant: "sec.least-privilege",
		attack: "a request naming another agent as its author",
		applies: (r) => r.surface === "request-folder",
		covered: (r) =>
			r.operation === "job.submit"
				? { test: SANDBOX, name: "JOB-1" }
				: r.operation === "schedule.create"
					? { test: SANDBOX, name: "SCHED-1" }
					: null,
	},
	{
		id: "symlink-or-hard-link",
		invariant: "sec.contained-paths",
		attack: "a request planted as a symlink or a hard link",
		applies: (r) => r.surface === "request-folder",
		covered: (r) =>
			r.operation === "job.submit"
				? { test: SANDBOX, name: "JOB-2, JOB-3" }
				: null,
	},
	// ── Copilot actions ────────────────────────────────────────────────────────
	{
		id: "unconfirmed-effect",
		invariant: "sec.confirmed-effects",
		attack: "the action's effect without the operator's confirmation",
		applies: (r) => r.surface === "copilot-action",
		covered: () => null,
	},
	// ── Timers and change streams ──────────────────────────────────────────────
	{
		id: "overlap-or-replay",
		invariant: "sec.input-validated",
		attack: "the trigger overlapping itself, or replayed after a crash",
		applies: (r) => r.surface === "trigger",
		covered: () => null,
	},
	// ── Platform ───────────────────────────────────────────────────────────────
	{
		id: "read-other-agent",
		invariant: "sec.least-privilege",
		attack: "read another agent's private files",
		applies: (r) => r.path === "agent OS user",
		covered: () => ({ test: SANDBOX, name: "OS-1" }),
	},
	{
		id: "write-other-agent",
		invariant: "sec.least-privilege",
		attack: "write into another agent's workdir",
		applies: (r) => r.path === "agent OS user",
		covered: () => ({ test: SANDBOX, name: "OS-2" }),
	},
	{
		id: "daemon-secrets",
		invariant: "sec.no-secrets-to-agents",
		attack: "read the daemon's environment (its secrets)",
		applies: (r) => r.path === "agent OS user",
		covered: () => ({ test: SANDBOX, name: "OS-3" }),
	},
	{
		id: "daemon-state",
		invariant: "sec.least-privilege",
		attack: "read the daemon's private state",
		applies: (r) => r.path === "agent OS user",
		covered: () => ({ test: SANDBOX, name: "OS-4" }),
	},
	{
		id: "sudo",
		invariant: "sec.least-privilege",
		attack: "sudo to root, to another agent, or to a helper",
		applies: (r) => r.path === "agent OS user",
		covered: () => ({ test: SANDBOX, name: "SUDO-1" }),
	},
	{
		id: "secrets-in-subprocesses",
		invariant: "sec.no-secrets-to-agents",
		attack: "find a platform secret in a tool or job subprocess's environment",
		applies: (r) => r.path === "agent OS user",
		covered: () => ({ test: SANDBOX, name: "ENV-1, ENV-2" }),
	},
	{
		id: "reach-agent-server",
		invariant: "sec.served-apart",
		attack:
			"another machine reaches a server an agent opened on all interfaces",
		applies: (r) => r.path === "the machine on the network",
		covered: () => ({ test: SANDBOX, name: "NET-1" }),
	},
	{
		id: "reach-teammate-app",
		invariant: "sec.served-apart",
		attack: "one agent reaches another agent's app on loopback",
		applies: (r) => r.path === "the machine on the network",
		covered: () => ({ test: SANDBOX, name: "APP-1" }),
	},
	{
		id: "helper-arguments",
		invariant: "sec.least-privilege",
		attack: "the firewall helper given arguments it must refuse",
		applies: (r) => r.path === "the daemon's sudo helpers",
		covered: () => ({ test: SANDBOX, name: "HELPER-1" }),
	},
	{
		id: "wrapper-to-root",
		invariant: "sec.least-privilege",
		attack: "a sudo wrapper run as root instead of an agent",
		applies: (r) => r.path === "the daemon's sudo helpers",
		covered: () => ({ test: SANDBOX, name: "HELPER-2" }),
	},
];

const SURFACES = [
	["control-plane", "Control plane (internet)"],
	["apps-host", "Apps host (internet)"],
	["monitor", "Monitor server (a mission machine's port 4000)"],
	["tool-api", "Tool API (port 4001, background jobs)"],
	["tool", "Agent and copilot tools"],
	["request-folder", "Request folders (agents write files the daemon acts on)"],
	[
		"copilot-action",
		"Copilot actions (proposed, then confirmed by the operator)",
	],
	["trigger", "Timers and change streams"],
	["platform", "Platform (no entry point)"],
];

function httpRows() {
	const rows = [];
	for (const surface of ["control-plane", "apps-host", "monitor", "tool-api"]) {
		const spec = JSON.parse(
			readFileSync(
				join(ROOT, "docs", "api", `${surface}.openapi.json`),
				"utf8",
			),
		);
		for (const [path, item] of Object.entries(spec.paths)) {
			const ops = Object.entries(item);
			// A route taking any method is one row, not five.
			const any = ops.every(([, op]) => op["x-magi-any-method"]);
			for (const [method, op] of any ? [["*", ops[0][1]]] : ops) {
				rows.push({
					surface,
					method: method.toUpperCase(),
					path,
					auth: op["x-magi-auth"],
					operation: op["x-magi-operation"] ?? "",
				});
			}
		}
	}
	return rows;
}

const FOLDER = {
	"job.submit": "jobs/pending/",
	"schedule.create": "schedules/",
	"schedule.cancel": "schedules/",
	"app.declare": "apps/requests/",
	"app.control": "apps/requests/",
};

function traceRows(entries) {
	const rows = [];
	for (const e of entries) {
		if (e.kind === "tool")
			rows.push({
				surface: "tool",
				method: "",
				path: e.name,
				actor: e.actor,
				operation: e.tag,
			});
		else if (e.kind === "file-request")
			rows.push({
				surface: "request-folder",
				method: "",
				path: FOLDER[e.tag] ?? e.name,
				operation: e.tag,
			});
		else if (e.kind === "copilot-action")
			rows.push({
				surface: "copilot-action",
				method: "",
				path: e.name,
				operation: e.tag,
			});
		else if (e.kind === "trigger")
			rows.push({
				surface: "trigger",
				method: "",
				path: `${e.name} (${e.file.split("/").pop()}:${e.line})`,
				operation: e.tag,
			});
	}
	return rows;
}

export function buildMatrix(entries) {
	const rows = [
		...httpRows(),
		...traceRows(entries),
		{ surface: "platform", method: "", path: "agent OS user", operation: "" },
		{
			surface: "platform",
			method: "",
			path: "the machine on the network",
			operation: "",
		},
		{
			surface: "platform",
			method: "",
			path: "the daemon's sudo helpers",
			operation: "",
		},
	];
	const cells = [];
	for (const row of rows) {
		for (const c of CLASSES) {
			if (!c.applies(row)) continue;
			const na = c.na?.(row) ?? null;
			const cov = na ? null : c.covered(row);
			cells.push({
				row,
				cls: c,
				status: na ? "n/a" : cov ? "covered" : "open",
				by: cov,
				reason: na,
			});
		}
	}
	return cells;
}

function rowLabel(r) {
	return `${r.method ? `${r.method} ` : ""}\`${r.path}\``;
}

export function renderMarkdown(cells) {
	const out = [
		"# The attack matrix",
		"",
		"Every entry point against every attack that applies to it (security assurance plan, part 2).",
		"Generated by `node scripts/security/matrix/matrix.mjs --write`; do not edit. A cell is **covered**",
		"when a test attacks it (the test's own control or mutation proves it can fail), **open** when no",
		"test does yet, or **n/a** with the reason. Results are not shown here: the repository is",
		"public, and a cell that fails is in code scanning (maintainers only).",
		"",
		"## Coverage",
		"",
		"| Surface | Cells | Covered | Open | n/a |",
		"|---|---|---|---|---|",
	];
	const by = (s) => cells.filter((c) => c.row.surface === s);
	let total = [0, 0, 0, 0];
	for (const [s, title] of SURFACES) {
		const cs = by(s);
		if (!cs.length) continue;
		const n = [
			cs.length,
			cs.filter((c) => c.status === "covered").length,
			cs.filter((c) => c.status === "open").length,
			cs.filter((c) => c.status === "n/a").length,
		];
		total = total.map((t, i) => t + n[i]);
		out.push(`| ${title} | ${n[0]} | ${n[1]} | ${n[2]} | ${n[3]} |`);
	}
	out.push(
		`| **All** | **${total[0]}** | **${total[1]}** | **${total[2]}** | **${total[3]}** |`,
		"",
	);
	out.push(
		"## Attack classes",
		"",
		"| Class | Invariant | Attack |",
		"|---|---|---|",
	);
	const seen = new Set();
	for (const c of CLASSES) {
		const key = `${c.id}|${c.attack}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(`| \`${c.id}\` | \`${c.invariant}\` | ${c.attack} |`);
	}
	out.push("");
	for (const [s, title] of SURFACES) {
		const cs = by(s);
		if (!cs.length) continue;
		out.push(
			`## ${title}`,
			"",
			"| Entry point | Operation | Attack class | Status | Test |",
			"|---|---|---|---|---|",
		);
		for (const c of cs) {
			const test = c.by
				? `\`${c.by.test.split("/").pop()}\` (${c.by.name})`
				: (c.reason ?? "");
			out.push(
				`| ${rowLabel(c.row)} | ${c.row.operation ? `\`${c.row.operation}\`` : ""} | \`${c.cls.id}\` | ${c.status} | ${test} |`,
			);
		}
		out.push("");
	}
	return `${out.join("\n")}\n`;
}

export function loadEntries() {
	return JSON.parse(
		readFileSync(join(ROOT, "docs", "security", "entry-points.json"), "utf8"),
	);
}

if (
	process.argv[1] === fileURLToPath(import.meta.url) &&
	process.argv.includes("--write")
) {
	const fresh = join(ROOT, "analysis", "entry-points.json");
	if (existsSync(fresh)) {
		const keep = JSON.parse(readFileSync(fresh, "utf8")).map(
			({ kind, actor, file, line, name, tag }) => ({
				kind,
				actor,
				file,
				line,
				name,
				tag,
			}),
		);
		writeFileSync(
			join(ROOT, "docs", "security", "entry-points.json"),
			`${JSON.stringify(keep, null, "\t")}\n`,
		);
	} else {
		console.error(
			"[matrix] no analysis/entry-points.json (run `npm run trace` first): keeping the committed copy",
		);
	}
	const cells = buildMatrix(loadEntries());
	writeFileSync(
		join(ROOT, "docs", "security", "attack-matrix.md"),
		renderMarkdown(cells),
	);
	const n = (s) => cells.filter((c) => c.status === s).length;
	console.log(
		`[matrix] ${cells.length} cells: ${n("covered")} covered, ${n("open")} open, ${n("n/a")} n/a → docs/security/attack-matrix.md`,
	);
}
