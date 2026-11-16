/**
 * The trace's join (scripts/trace/findings.mjs) and reach (reach.mjs) on
 * small synthetic inputs: what each kind of finding means, independent of
 * the real catalog and of CodeQL.
 */
import { describe, expect, it } from "vitest";
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
		];
		const { findings } = computeFindings(baseline(), [], writes, null);
		expect(
			findings
				.filter((f) => f.kind === "store.foreign-writer")
				.map((f) => f.where[0]),
		).toEqual(["rogue-c/c.ts:10"]);
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
		expect(
			findings.filter((f) => f.kind === "inv.unenforced").map((f) => f.about),
		).toEqual(["sec.contained-paths"]);
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
