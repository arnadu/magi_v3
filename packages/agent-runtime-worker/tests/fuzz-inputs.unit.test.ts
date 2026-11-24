/**
 * Property-based fuzzing (security assurance plan, part 4) of what agents and models write:
 * paths, app requests, schedule files and tool arguments. Each property states the security
 * invariant, and each has a control proving it is not vacuous (some inputs are accepted).
 *
 * The seed is fixed so the suite is deterministic; FAST_CHECK_SEED=<n> explores another part of
 * the input space, and a failure prints the seed and the shrunk counterexample to replay.
 */
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { APP_NAME_RE, checkAppRequest } from "../src/app-requests.js";
import { resolveInside } from "../src/safe-path.js";
import { validateScheduleSpec } from "../src/schedule-ingest.js";
import { checkToolArguments, MAX_REJECTION_CHARS } from "../src/tool-args.js";

// Properties run hundreds of cases: under the parallel suite they need more than the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

const RUNS = {
	seed: Number(process.env.FAST_CHECK_SEED ?? 20261124),
	numRuns: 400,
};

/** Mostly `valid`, sometimes `other`: a property over random junk alone would rarely reach the accepting branch. */
function mostly<T, U>(valid: fc.Arbitrary<T>, other: fc.Arbitrary<U>) {
	return fc.oneof(
		{ arbitrary: valid, weight: 4 },
		{ arbitrary: other, weight: 1 },
	);
}

function within(root: string, p: string): boolean {
	const rel = relative(root, p);
	return (
		rel === "" ||
		(!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))
	);
}

/** The real location of `p`: its realpath, or its nearest existing ancestor's plus the rest. */
function realOf(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		const parent = dirname(p);
		return parent === p ? p : join(realOf(parent), basename(p));
	}
}

let base: string;
let root: string;
let shared: string;
let work: string;
let outside: string;

beforeAll(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "magi-fuzz-")));
	root = join(base, "root");
	outside = join(base, "outside");
	shared = join(base, "shared");
	work = join(base, "work");
	for (const d of [
		root,
		join(root, "a"),
		outside,
		shared,
		join(shared, "site"),
		work,
	])
		mkdirSync(d);
	writeFileSync(join(root, "a", "f.txt"), "in");
	writeFileSync(join(outside, "secret.txt"), "out");
	writeFileSync(join(outside, "app.py"), "out");
	writeFileSync(join(shared, "app.py"), "in");
	writeFileSync(join(work, "mine.py"), "in");
	symlinkSync(outside, join(root, "link-out"));
	symlinkSync(join(root, "a"), join(root, "link-a"));
	symlinkSync("..", join(root, "a", "link-up"));
	symlinkSync(join(outside, "nope"), join(root, "dangling"));
	symlinkSync(join(outside, "app.py"), join(shared, "link-app.py"));
	symlinkSync(outside, join(shared, "link-dir"));
	symlinkSync(join(outside, "secret.txt"), join(work, "link-secret.py"));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const segment = fc.constantFrom(
	"a",
	"f.txt",
	"link-out",
	"link-a",
	"link-up",
	"dangling",
	"..",
	".",
	"x",
	"secret.txt",
	"",
	"%2e%2e",
	"a\\..",
);

describe("resolveInside never returns a path whose real location is outside the root", () => {
	it("for any mix of names, .., symlinks in and out, dangling links, absolute or relative", () => {
		const requested = fc.tuple(
			fc.constantFrom("", "/", "ROOT/"),
			fc.array(segment, { minLength: 1, maxLength: 7 }),
		);
		let accepted = 0;
		fc.assert(
			fc.property(requested, ([prefix, segs]) => {
				const p = prefix.replace("ROOT", root) + segs.join("/");
				let got: string;
				try {
					got = resolveInside(root, p);
				} catch {
					return true;
				}
				accepted++;
				return within(realpathSync(root), realOf(got));
			}),
			RUNS,
		);
		expect(accepted).toBeGreaterThan(0);
		expect(resolveInside(root, "a/f.txt")).toBe(join(root, "a", "f.txt"));
	});
});

describe("an app request only ever declares files in its owner's workdir or the shared folder", () => {
	const validPaths = () => [
		join(shared, "app.py"),
		join(shared, "site"),
		join(work, "mine.py"),
	];
	const hostilePaths = () => [
		join(shared, "link-app.py"),
		join(shared, "link-dir"),
		join(work, "link-secret.py"),
		join(outside, "app.py"),
		outside,
		`${shared}/../outside/app.py`,
		`${shared}/site/../../outside`,
		"shared/app.py",
		"",
		"/",
		"/etc/passwd",
	];
	const anyPath = () =>
		mostly(
			fc.constantFrom(...validPaths()),
			fc.constantFrom(...hostilePaths()),
		);
	const deps = () => ({
		sharedDir: shared,
		workdirOf: (a: string) => (a === "alice" ? work : undefined),
	});

	it("whatever the request says (action, name, kind, path, handlers, description)", () => {
		const anyValue = fc.oneof(
			fc.string(),
			fc.integer(),
			fc.constant(null),
			fc.constant(undefined),
		);
		const request = fc.record(
			{
				action: mostly(
					fc.constant("declare"),
					fc.oneof(fc.constantFrom("start", "stop", "remove"), anyValue),
				),
				name: mostly(
					fc.constantFrom("dash", "my-app"),
					fc.oneof(fc.constantFrom("A", "../x", "x".repeat(41)), anyValue),
				),
				kind: mostly(fc.constantFrom("jupyter", "gradio", "site"), anyValue),
				path: mostly(anyPath(), anyValue),
				handlers: mostly(anyPath(), anyValue),
				description: mostly(fc.string({ maxLength: 400 }), anyValue),
			},
			{ requiredKeys: ["action", "name", "kind", "path"] },
		);
		let declared = 0;
		fc.assert(
			fc.property(request, fc.constantFrom("alice", "bob"), (raw, owner) => {
				const c = checkAppRequest(raw, owner, deps());
				if (!c.ok) return true;
				if (!("declaration" in c)) return APP_NAME_RE.test(c.name);
				declared++;
				const d = c.declaration;
				const roots = owner === "alice" ? [work, shared] : [shared];
				const inside = (p: string) =>
					roots.some((r) => within(realpathSync(r), realpathSync(p)));
				return (
					d.owner === owner &&
					APP_NAME_RE.test(d.name) &&
					inside(d.path) &&
					(d.handlers === undefined || inside(d.handlers)) &&
					d.description.length <= 300
				);
			}),
			RUNS,
		);
		expect(declared).toBeGreaterThan(0);
	});
});

describe("a schedule file can only schedule its author's jobs and message the roster", () => {
	const roster = new Set(["alice", "bob", "lead"]);
	const now = () => new Date("2026-11-24T12:00:00Z");

	it("whatever the file says", () => {
		const anyValue = fc.oneof(
			fc.string(),
			fc.integer(),
			fc.constant(null),
			fc.boolean(),
		);
		const agent = mostly(
			fc.constantFrom("alice", "bob", "lead", "root", "", "alice "),
			anyValue,
		);
		const jobSpec = fc.record(
			{
				agentId: agent,
				scriptPath: mostly(
					fc.constantFrom("/w/run.sh", "run.sh", "../x"),
					anyValue,
				),
				args: mostly(fc.array(fc.string(), { maxLength: 3 }), anyValue),
				notifyAgentId: agent,
				notifySubject: mostly(fc.string({ maxLength: 250 }), anyValue),
				linuxUser: fc.constantFrom("root", "bob"),
				env: fc.constant({ LD_PRELOAD: "/tmp/x.so" }),
			},
			{ requiredKeys: ["agentId", "scriptPath"] },
		);
		const spec = fc.record(
			{
				cron: mostly(
					fc.constantFrom("0 9 * * *", "*/5 * * * *", "* * * * *", "bad"),
					anyValue,
				),
				label: mostly(fc.constant("daily"), fc.constant("other")),
				jobSpec: mostly(jobSpec, anyValue),
				to: mostly(fc.array(agent, { maxLength: 4 }), anyValue),
				subject: mostly(fc.string({ maxLength: 250 }), anyValue),
				body: mostly(fc.string({ maxLength: 50 }), anyValue),
			},
			{ requiredKeys: ["cron"] },
		);
		const allowedJobKeys = new Set([
			"agentId",
			"scriptPath",
			"args",
			"notifyAgentId",
			"notifySubject",
		]);
		let accepted = 0;
		fc.assert(
			fc.property(spec, fc.constantFrom("alice", "bob"), (raw, owner) => {
				const r = validateScheduleSpec(raw, "daily", owner, roster, now);
				if ("reject" in r) return true;
				accepted++;
				if (r.kind === "job") {
					const j = r.jobSpec;
					return (
						j.agentId === owner &&
						(raw.jobSpec as { agentId?: unknown }).agentId === owner &&
						Object.keys(j).every((k) => allowedJobKeys.has(k)) &&
						(j.notifyAgentId === undefined || roster.has(j.notifyAgentId))
					);
				}
				return (
					r.to.length > 0 &&
					r.to.every((t) => roster.has(t)) &&
					r.subject.length <= 200
				);
			}),
			RUNS,
		);
		expect(accepted).toBeGreaterThan(0);
	});
});

describe("tool arguments a tool receives always match its schema", () => {
	const tool = {
		name: "Sample",
		parameters: Type.Object({
			path: Type.String(),
			count: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
			tags: Type.Optional(Type.Array(Type.String())),
			options: Type.Optional(Type.Object({ deep: Type.Boolean() })),
		}),
	};

	it("whatever the model sends: wrong types, JSON in strings, extra keys, huge values", () => {
		const value = fc.oneof(
			fc.string(),
			fc.integer(),
			fc.double(),
			fc.boolean(),
			fc.constant(null),
			fc.constantFrom(
				'["a","b"]',
				'{"deep":true}',
				'{"deep":"yes"}',
				"5",
				"11",
				"-1",
				"true",
				"x".repeat(20_000),
			),
			fc.array(fc.oneof(fc.string(), fc.integer()), { maxLength: 3 }),
			fc.dictionary(
				fc.string({ maxLength: 5 }),
				fc.oneof(fc.boolean(), fc.string()),
			),
		);
		const args = fc.oneof(
			fc.record(
				{
					path: value,
					count: value,
					tags: value,
					options: value,
					extra: value,
				},
				{ requiredKeys: [] },
			),
			value,
			fc.constant(undefined),
		);
		let accepted = 0;
		fc.assert(
			fc.property(args, (a) => {
				const r = checkToolArguments(tool, {
					id: "1",
					name: "Sample",
					arguments: a,
				});
				if (!r.ok) return r.message.length <= MAX_REJECTION_CHARS + 200;
				accepted++;
				return Value.Check(tool.parameters, r.args);
			}),
			RUNS,
		);
		expect(accepted).toBeGreaterThan(0);
	});
});
