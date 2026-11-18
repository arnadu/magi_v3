/**
 * The trace's join (scripts/trace/findings.mjs) and reach (reach.mjs) on
 * small synthetic inputs: what each kind of finding means, independent of
 * the real catalog and of CodeQL.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	about,
	build,
	covers,
	insufficient,
	record,
	renderView,
	sample,
} from "../../../scripts/trace/decisions.mjs";
import { computeFindings, markNew } from "../../../scripts/trace/findings.mjs";
import {
	callGraph,
	entryReach,
	linkHttpHops,
} from "../../../scripts/trace/reach.mjs";

const fn = (
	id: string,
	file: string,
	line: number,
	endLine: number,
	name: string,
	parent = "",
) => ({ id, file, line, endLine, name, parent });

/** A catalog with one entity, one store, one operation. */
function baseline(overrides: Record<string, unknown> = {}) {
	return {
		OPERATIONS: [
			{
				id: "thing.change",
				intent: "Change a thing",
				actors: ["OP", "CC"],
				home: "home-c",
			},
			{
				id: "thing.forget",
				intent: "Forget a thing",
				actors: ["OP"],
				home: "home-c",
			},
		],
		ENTITIES: [
			{
				id: "thing",
				store: {
					kind: "collection",
					collection: "things",
					type: "T",
					statusField: "status",
				},
				states: [
					{ id: "new", meaning: "" },
					{ id: "done", meaning: "", stored: "complete" },
					{ id: "gone", meaning: "" },
				],
				transitions: [
					{ from: null, event: "create", to: "new", actors: ["OP"] },
					{ from: "new", event: "finish", to: "done", actors: ["OP"] },
				],
				invariants: [
					{ id: "thing.ok", text: "", enforcedBy: [{ kind: "test" }] },
				],
			},
		],
		PLATFORM_INVARIANTS: [],
		COMPONENTS: [],
		SECURITY_INVARIANTS: [
			{ id: "sec.contained-paths", text: "", enforcedBy: [] },
		],
		DATA_STORES: [
			{
				collection: "things",
				holds: "thing",
				owner: "home-c",
				alsoWrittenBy: [{ component: "helper-c", what: "pruning" }],
			},
		],
		componentsOwning: (f: string) => [f.split("/")[0]],
		...overrides,
	};
}

const entry = (
	name: string,
	actor: string,
	kind: string,
	functions: { id: string; file: string }[],
) => ({
	kind,
	actor,
	name,
	file: "x/entry.ts",
	line: 1,
	tag: "thing.change",
	reach: { functions, unresolvedCalls: [], httpHops: [] },
});

const write = (file: string, fnId: string, status?: object) => ({
	file,
	line: 10,
	function: "f",
	method: "updateOne",
	collection: "things",
	fn: fnId,
	...(status ? { status } : {}),
});

describe("trace join", () => {
	it("checks status writes against the catalog's transitions", () => {
		const writes = [
			write("home-c/a.ts", "w1", { to: ["new"], from: { op: "none" } }),
			write("home-c/b.ts", "w2", {
				to: ["complete"],
				from: { op: "eq", values: ["new"] },
			}),
			write("home-c/c.ts", "w3", { to: ["gone"], from: { op: "any" } }),
			write("home-c/d.ts", "w4", {
				to: ["zombie"],
				from: { op: "ne", values: ["gone"] },
			}),
		];
		const { findings } = computeFindings(baseline(), [], writes, null);
		const undeclared = findings.filter(
			(f) => f.kind === "status.undeclared-transition",
		);
		expect(undeclared.map((f) => f.where[0])).toEqual([
			"home-c/c.ts:10",
			"home-c/d.ts:10",
		]);
		expect(undeclared[0].undeclared).toEqual([
			"new → gone",
			"complete → gone",
			"gone → gone",
		]);
		expect(undeclared[0].text).toContain("does not check the current status");
		expect(
			findings
				.filter((f) => f.kind === "status.unknown-state")
				.map((f) => f.text),
		).toEqual([expect.stringContaining('"zombie"')]);
		expect(
			findings.filter((f) => f.kind === "status.unseen-transition"),
		).toEqual([]);
	});

	it("reports writes by a component that does not own the collection", () => {
		const writes = [
			write("home-c/a.ts", "w1"),
			write("helper-c/b.ts", "w2"),
			write("rogue-c/c.ts", "w3"),
			{ ...write("rogue-c/c.ts", "w3"), line: 24 },
		];
		const { findings } = computeFindings(baseline(), [], writes, null);
		// Two writes of one function are one finding, at both places.
		expect(
			findings
				.filter((f) => f.kind === "store.foreign-writer")
				.map((f) => f.where),
		).toEqual([["rogue-c/c.ts:10", "rogue-c/c.ts:24"]]);
	});

	it("compares the entry points of one operation", () => {
		const shared = { id: "w1", file: "home-c/a.ts" };
		const writes = [write("home-c/a.ts", "w1"), write("home-c/b.ts", "w2")];
		const entries = [
			entry("POST /thing", "OP", "route", [
				shared,
				{ id: "w2", file: "home-c/b.ts" },
			]),
			entry("change_thing", "CC", "copilot-action", [
				{ id: "other", file: "else-c/x.ts" },
			]),
		];
		const { findings } = computeFindings(baseline(), entries, writes, null);
		const kinds = findings.map((f) => `${f.kind} ${f.about}`).sort();
		expect(kinds).toContain("op.home-not-reached thing.change");
		expect(kinds).toContain("op.divergent-writes thing.change");
		expect(kinds).toContain("op.no-entry-point thing.forget");
		const divergent = findings.find((f) => f.kind === "op.divergent-writes");
		expect(divergent.lacks).toEqual([
			{
				entryPoint: "copilot-action change_thing",
				where: "x/entry.ts:1",
				writes: [
					"things.updateOne@home-c/a.ts:10",
					"things.updateOne@home-c/b.ts:10",
				],
			},
		]);
	});

	it("files security results under their invariant and lists unenforced invariants", () => {
		const sarif = {
			runs: [
				{
					results: [
						{
							ruleId: "js/path-injection",
							message: { text: "path from user" },
							locations: [
								{
									physicalLocation: {
										artifactLocation: { uri: "home-c/f.ts" },
										region: { startLine: 3 },
									},
								},
							],
						},
					],
				},
			],
		};
		const { security, findings } = computeFindings(baseline(), [], [], sarif);
		expect(security[0].invariant).toBe("sec.contained-paths");
		const unenforced = findings.filter((f) => f.kind === "inv.unenforced");
		expect(unenforced.map((f) => f.about)).toEqual(["sec.contained-paths"]);
		// The finding is about the catalog, and its key predates this wording,
		// so the reviewers' decisions on it still apply.
		expect(unenforced[0].text).toMatch(/^The catalog names nothing/);
		expect(unenforced[0].key).toBe(
			createHash("sha1")
				.update(
					"inv.unenforced|sec.contained-paths|Nothing enforces sec.contained-paths yet.",
				)
				.digest("hex")
				.slice(0, 12),
		);
	});

	it("marks what is new since the previous run", () => {
		const fs = [{ key: "a" }, { key: "b" }];
		expect(markNew(fs, [{ key: "a" }]).map((f) => f.new)).toEqual([
			false,
			true,
		]);
		expect(markNew(fs, null).map((f) => f.new)).toEqual([null, null]);
	});
});

describe("trace reach", () => {
	const functions = [
		fn("r", "a.ts", 1, 9, "register"),
		fn("h", "a.ts", 2, 5, "handler", "r"),
		fn("g", "b.ts", 1, 3, "helper"),
		fn("c", "b.ts", 2, 2, "closure", "g"),
		fn("x", "c.ts", 1, 9, "unrelated"),
		fn("m", "m.ts", 1, 5, "monitorHandler"),
	];
	const calls = [{ file: "a.ts", line: 3, caller: "h", calleeId: "g" }];

	it("follows calls and nested functions from the entry point's span", () => {
		const graph = callGraph(functions, calls, [
			{ file: "b.ts", line: 2, caller: "g", name: "deps" },
		]);
		const [r] = entryReach(graph, [{ file: "a.ts", line: 2, endLine: 6 }]);
		expect(r.functions.map((f: { id: string }) => f.id).sort()).toEqual([
			"c",
			"g",
			"h",
		]);
		expect(r.unresolvedCalls.map((u: { name: string }) => u.name)).toEqual([
			"deps",
		]);
	});

	it("crosses an HTTP call into the route it names", () => {
		const graph = callGraph(functions, calls, []);
		const route = {
			kind: "monitor-route",
			actor: "OP",
			name: 'POST "/pause-agent"',
			file: "m.ts",
			line: 1,
			endLine: 5,
		};
		const sources: Record<string, string> = {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text containing a template literal
			"b.ts": "x\nawait post(`${base}/pause-agent`, body);\nx",
		};
		linkHttpHops(graph, [route], (f: string) => sources[f] ?? "");
		const [r] = entryReach(graph, [{ file: "a.ts", line: 2, endLine: 6 }]);
		expect(r.httpHops).toEqual(['monitor-route POST "/pause-agent"']);
		expect(r.functions.map((f: { id: string }) => f.id)).toContain("m");
	});
});

describe("reviewers' decisions on the trace's findings", () => {
	const f = (key: string, kind: string, about: string, isNew = false) => ({
		key,
		kind,
		about,
		text: `${kind} about ${about}`,
		where: ["packages/a.ts:1"],
		new: isNew,
	});

	it("selects findings by kind, optionally narrowed by a baseline-id prefix", () => {
		expect(covers(["sec.result"], f("k", "sec.result", "sec.authorized"))).toBe(
			true,
		);
		expect(
			covers(
				["inv.unenforced:sec."],
				f("k", "inv.unenforced", "sec.authorized"),
			),
		).toBe(true);
		expect(
			covers(
				["inv.unenforced:sec."],
				f("k", "inv.unenforced", "mission.capped"),
			),
		).toBe(false);
	});

	it("shows a reviewer where its findings are and what is new, with no count left to clear, within its size", () => {
		const fs = [
			f("aaaaaaaaaaaa", "op.home-not-reached", "mission.launch", true),
			...Array.from({ length: 200 }, (_, i) => ({
				...f(i.toString(16).padStart(12, "0"), "store.foreign-writer", `c${i}`),
				where: [`packages/b${i % 3}.ts:${i}`],
			})),
		];
		const text = renderView(
			"code-reviewer",
			{ commit: "abc1234", time: "2026-11-16T12:00:00Z" },
			fs,
			[],
			3000,
		);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(3000);
		expect(text).toContain("## New since the last scan");
		expect(text).toMatch(/- `aaaaaaaaaaaa` op\.home-not-reached/);
		expect(text).toContain("- b0.ts: 67");
		expect(text).not.toMatch(/not yet examined|open:/i);
		expect(text).not.toContain("`00000000000a`");
	});

	function analysis() {
		const dir = mkdtempSync(join(tmpdir(), "decisions-"));
		writeFileSync(
			join(dir, "findings.json"),
			JSON.stringify({
				meta: { commit: "abc1234", time: "t" },
				findings: [
					f("aaaaaaaaaaaa", "op.divergent-writes", "x.one"),
					f("bbbbbbbbbbbb", "op.divergent-writes", "x.two"),
				],
			}),
		);
		writeFileSync(
			join(dir, "coverage.json"),
			JSON.stringify({ agents: { cr: ["op.divergent-writes"] } }),
		);
		build(dir, join(dir, "coverage.json"));
		return dir;
	}
	const view = (dir: string) =>
		readFileSync(join(dir, "findings-cr.md"), "utf8");

	it("records a decision only with a cited, finding-specific reason", () => {
		const dir = analysis();
		expect(() =>
			record(dir, "aaaaaaaaaaaa", "dismissed", "same pattern as before", "cr"),
		).toThrow(/cite the file:line/);
		record(dir, "aaaaaaaaaaaa", "dismissed", "guarded at a.ts:3", "cr");
		expect(() =>
			record(dir, "bbbbbbbbbbbb", "dismissed", "guarded at a.ts:3", "cr"),
		).toThrow(/same reason/);
		expect(() =>
			record(dir, "bbbbbbbbbbbb", "deferred", "later", "cr"),
		).toThrow(/must be one of/);
		expect(view(dir)).toContain(
			"0 findings raised, 0 catalog questions, 1 dismissed.",
		);
	});

	it("refuses a dismissal that does not address the places the finding names", () => {
		const dir = analysis();
		expect(() =>
			record(dir, "aaaaaaaaaaaa", "dismissed", "fine, see z.ts:90", "cr"),
		).toThrow(/does not address what the finding names \(packages\/a\.ts:1\)/);
		const gap = {
			...f("cccccccccccc", "op.divergent-writes", "x.three"),
			lacks: [
				{
					entryPoint: "route POST /x",
					where: "r.ts:5",
					writes: ["things.updateOne@claims.ts:25"],
				},
			],
		};
		const d = (reason: string) => ({ disposition: "dismissed", reason });
		expect(insufficient(d("dispatch at r.ts:5 is not followed"), gap)).toMatch(
			/claims\.ts:25/,
		);
		expect(
			insufficient(d("claims.ts:27 is reached through q.ts:4"), gap),
		).toBeNull();
	});

	it("lists catalog questions for the product owner, held to a dismissal's evidence", () => {
		const dir = analysis();
		expect(() =>
			record(dir, "aaaaaaaaaaaa", "catalog", "fine, see z.ts:90", "cr"),
		).toThrow(/does not address/);
		record(dir, "aaaaaaaaaaaa", "catalog", "a.ts:1 is a second owner", "cr");
		const q = readFileSync(join(dir, "catalog-questions.md"), "utf8");
		expect(q).toContain("`x.one` (op.divergent-writes, `aaaaaaaaaaaa`, cr");
		expect(view(dir)).toContain(
			"0 findings raised, 1 catalog questions, 0 dismissed.",
		);
	});

	it("samples standing dismissals, leaving out those already checked", () => {
		const dir = analysis();
		record(dir, "aaaaaaaaaaaa", "dismissed", "guarded at a.ts:2", "cr");
		record(dir, "bbbbbbbbbbbb", "finding", "CR-1 at a.ts:1", "cr");
		expect(sample(dir, 5, "seed").map((s) => s.key)).toEqual(["aaaaaaaaaaaa"]);
		expect(sample(dir, 5, "seed", new Set(["cr aaaaaaaaaaaa"]))).toEqual([]);
	});

	it("looks up findings by file or baseline id, with only the caller's own conclusion", () => {
		const dir = analysis();
		record(dir, "aaaaaaaaaaaa", "finding", "CR-1 at a.ts:1", "cr");
		record(dir, "bbbbbbbbbbbb", "dismissed", "guarded at a.ts:4", "qa");
		const byFile = about(dir, "a.ts", "cr", ["op.divergent-writes"]);
		expect(byFile).toContain("2 finding(s)");
		expect(byFile).toContain("your conclusion: finding");
		expect(byFile).not.toContain("guarded at a.ts:4");
		expect(about(dir, "x.two", "cr", null)).toContain("1 finding(s)");
		expect(about(dir, "a.ts", "qa", ["inv.unenforced"])).toContain(
			"0 finding(s)",
		);
	});

	it("sets aside decisions before an agent's since date, and marks one recorded without evidence", () => {
		const dir = analysis();
		writeFileSync(
			join(dir, "dispositions.jsonl"),
			`${JSON.stringify({ key: "aaaaaaaaaaaa", agent: "cr", disposition: "finding", reason: "CR-1 at a.ts:1", at: "2026-01-01" })}\n${JSON.stringify({ key: "bbbbbbbbbbbb", agent: "cr", disposition: "dismissed", reason: "by analogy", at: "2026-01-01" })}\n`,
		);
		build(dir, join(dir, "coverage.json"));
		expect(view(dir)).toContain("1 findings raised");
		expect(about(dir, "x.two", "cr", null)).toContain(
			"does not count: cites no file:line",
		);
		writeFileSync(
			join(dir, "coverage.json"),
			JSON.stringify({
				agents: { cr: ["op.divergent-writes"] },
				since: { cr: "2999-01-01T00:00:00Z" },
			}),
		);
		build(dir, join(dir, "coverage.json"));
		expect(view(dir)).toContain("0 findings raised");
		expect(about(dir, "x.one", "cr", null)).not.toContain("your conclusion");
		expect(sample(dir, 5, "seed")).toEqual([]);
	});
});
