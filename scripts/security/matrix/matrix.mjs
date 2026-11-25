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
 * daemon's sudo helpers, platform tasks).
 *
 *   node scripts/security/matrix/matrix.mjs --write   # refresh the copy and docs/security/attack-matrix.md
 *
 * attack-matrix.unit.test.ts (control plane) renders it again and compares, and checks that every
 * test the matrix names exists and names the cell.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
		covered: (r) =>
			r.operation === "mission.platform-task"
				? {
						test: "packages/agent-runtime-worker/tests/platform-tasks.unit.test.ts",
						name: "never starts a task twice at once",
					}
				: null,
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
		id: "write-task-output",
		invariant: "sec.least-privilege",
		attack:
			"an agent writes the output a platform task keeps (the reference copy)",
		applies: (r) => r.path === "platform tasks",
		covered: () => ({ test: SANDBOX, name: "PLAT-1" }),
	},
	{
		id: "run-task-wrapper",
		invariant: "sec.least-privilege",
		attack: "an agent runs the platform-task wrapper",
		applies: (r) => r.path === "platform tasks",
		covered: () => ({ test: SANDBOX, name: "PLAT-2" }),
	},
	{
		id: "task-arguments",
		invariant: "sec.input-validated",
		attack:
			"a mission's task list fetches elsewhere or writes outside the task's folder",
		applies: (r) => r.path === "platform tasks",
		covered: () => ({ test: SANDBOX, name: "PLAT-3" }),
	},
	{
		id: "task-reach",
		invariant: "sec.least-privilege",
		attack: "a compromised task reaches the agents' files or sudo",
		applies: (r) => r.path === "platform tasks",
		covered: () => ({ test: SANDBOX, name: "PLAT-4" }),
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

/** The trust boundaries (threat-model TB ids) a row's attacks cross. */
export function boundariesOf(r) {
	switch (r.surface) {
		case "control-plane":
			if (r.path.startsWith("/api/mission-copilot/github/")) return ["TB-19"];
			if (r.path.startsWith("/api/mission-copilot/resources/"))
				return ["TB-22"];
			if (r.path.startsWith("/missions/{id}")) return ["TB-11"];
			if (r.path === "/api/copilot/files") return ["TB-9", "TB-21"];
			if (r.path === "/firebase-config.js") return ["TB-14"];
			return ["TB-9"];
		case "apps-host":
			return ["TB-26"];
		case "monitor":
			return r.path.startsWith("/a/") ? ["TB-25"] : ["TB-11", "TB-2"];
		case "tool-api":
			return ["TB-5"];
		case "tool":
			return r.actor === "CC" ? ["TB-15"] : ["TB-6"];
		case "request-folder":
			if (r.operation === "job.submit") return ["TB-4"];
			return r.operation.startsWith("app.") ? ["TB-24"] : ["TB-7"];
		case "copilot-action":
			return ["TB-15"];
		case "platform":
			return {
				"agent OS user": ["TB-3", "TB-4"],
				"the machine on the network": ["TB-23"],
				"the daemon's sudo helpers": ["TB-3", "TB-23"],
				"platform tasks": ["TB-27"],
			}[r.path];
		default:
			return [];
	}
}

/**
 * Mitigated (✅) STRIDE rows that cite no proof. A ceiling, not a target: it may only go down as
 * rows gain their proof (a sandbox cell id or a named test file in the row's notes).
 */
export const CLAIMED_ROWS_CEILING = 84;

/** Where a test file named in the threat model lives, or null. */
function findTestFile(name) {
	for (const pkg of readdirSync(join(ROOT, "packages"))) {
		const p = join("packages", pkg, "tests", name);
		if (existsSync(join(ROOT, p))) return p;
	}
	return null;
}

/** The proofs a STRIDE row's notes cite: named test files, and sandbox cell ids (PLAT-1..4 is four). */
function proofsIn(notes) {
	const proofs = [];
	for (const m of notes.matchAll(
		/([\w.-]+\.(?:unit|integration|seam)\.test\.ts)/g,
	)) {
		const path = findTestFile(m[1]);
		proofs.push({ test: path ?? m[1], name: null, missing: !path });
	}
	for (const m of notes.matchAll(/sandbox ([A-Z]+)-(\d+)(?:\.\.(\d+))?/g)) {
		const last = Number(m[3] ?? m[2]);
		for (let i = Number(m[2]); i <= last; i++) {
			proofs.push({ test: SANDBOX, name: `${m[1]}-${i}` });
		}
	}
	return proofs;
}

function statusOf(cell) {
	if (cell.includes("✅")) return "mitigated";
	if (cell.includes("⚠")) return "open";
	if (cell.startsWith("~")) return "partial";
	return cell.startsWith("A") ? "accepted" : "other";
}

/** The STRIDE rows of docs/security/threat-model.md, each with its boundary, status and proofs. */
export function parseThreatModel(text) {
	const start = text.indexOf("## STRIDE Threat Table");
	const end = text.indexOf("\n## ", start + 10);
	const rows = [];
	let boundary = null;
	for (const line of text.slice(start, end < 0 ? undefined : end).split("\n")) {
		boundary = line.match(/^### (TB-\d+)/)?.[1] ?? boundary;
		const isRow =
			line.startsWith("|") &&
			!line.startsWith("|--") &&
			!line.startsWith("| Threat");
		const cells = line
			.replace(/^\||\|$/g, "")
			.split("|")
			.map((c) => c.trim());
		if (!boundary || !isRow || cells.length < 4) continue;
		rows.push({
			boundary,
			threat: cells[0],
			status: statusOf(cells[2]),
			proofs: proofsIn(cells.slice(3).join("|")),
		});
	}
	return rows;
}

export function loadThreatRows() {
	return parseThreatModel(
		readFileSync(join(ROOT, "docs", "security", "threat-model.md"), "utf8"),
	);
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
		{
			surface: "platform",
			method: "",
			path: "platform tasks",
			operation: "mission.platform-task",
		},
	];
	const cells = [];
	for (const row of rows) {
		row.boundaries = boundariesOf(row) ?? [];
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

export function renderMarkdown(cells, threatRows = loadThreatRows()) {
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
		"## By trust boundary",
		"",
		"The boundaries are the threat model's (`docs/security/threat-model.md`). Its mitigated (✅) rows are",
		"**proven** when their notes cite a sandbox cell or a named test, and **claimed** otherwise;",
		`claimed rows may only decrease (ceiling ${CLAIMED_ROWS_CEILING}).`,
		"",
		"| Boundary | Matrix cells | Covered | Open | ✅ proven | ✅ claimed | ~ partial | ⚠️ open | Accepted |",
		"|---|---|---|---|---|---|---|---|---|",
	);
	const ids = new Set([
		...threatRows.map((r) => r.boundary),
		...cells.flatMap((c) => c.row.boundaries),
	]);
	const tb = [...ids].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
	for (const id of tb) {
		const cs = cells.filter((c) => c.row.boundaries.includes(id));
		const rs = threatRows.filter((r) => r.boundary === id);
		const n = (st) => rs.filter((r) => r.status === st).length;
		const proven = rs.filter(
			(r) => r.status === "mitigated" && r.proofs.length > 0,
		).length;
		out.push(
			`| ${id} | ${cs.length} | ${cs.filter((c) => c.status === "covered").length} | ${cs.filter((c) => c.status === "open").length} | ${proven} | ${n("mitigated") - proven} | ${n("partial")} | ${n("open")} | ${n("accepted")} |`,
		);
	}
	out.push("");
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
			"| Entry point | Boundary | Operation | Attack class | Status | Test |",
			"|---|---|---|---|---|---|",
		);
		for (const c of cs) {
			const test = c.by
				? `\`${c.by.test.split("/").pop()}\` (${c.by.name})`
				: (c.reason ?? "");
			out.push(
				`| ${rowLabel(c.row)} | ${c.row.boundaries.join(", ")} | ${c.row.operation ? `\`${c.row.operation}\`` : ""} | \`${c.cls.id}\` | ${c.status} | ${test} |`,
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
