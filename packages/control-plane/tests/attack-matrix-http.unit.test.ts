/**
 * The attack matrix's HTTP cells for the control plane (security assurance plan, step 3),
 * generated from docs/api/control-plane.openapi.json and run against the real app (createApp)
 * with a fake database and two mocked tenants. Each cell's verdict is computed by code:
 *
 *   no-credential   an operator route answers 401 to a request without any credential, and
 *                   writes nothing;
 *   bad-mission-token  a mission-copilot route answers 401/403 to a wrong token, writing nothing;
 *   other-tenant    tenant B asking for tenant A's mission gets exactly the answer it gets for a
 *                   mission that does not exist (it learns nothing, not even existence), never
 *                   sees A's data, and changes none of A's documents.
 *
 * The can-fail check: the other-tenant cells run again with the tenant rule (auth-scope.ts) stubbed
 * out. A cell that still passes then proves nothing about the rule (it is refused earlier, e.g.
 * for its body), and is reported as unproven instead of covered. A route that also refuses its
 * owner here (disabled, or needing state this fake world lacks) is reported as untestable.
 */
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Doc, fakeDb } from "./support/fake-db.js";

/** Guards replaced for the can-fail runs: each must make its cells break. */
const MUTATE = { tenantRule: false, signIn: false, missionToken: false };

vi.mock("../src/firebase.js", () => ({
	verifyFirebaseToken: vi.fn(async (token: string) => {
		if (token === "token-a") return { uid: "user-a", email: "a@x" };
		if (token === "token-b") return { uid: "user-b", email: "b@x" };
		throw new Error("invalid token");
	}),
}));
vi.mock("../src/auth.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/auth.js")>();
	return {
		...real,
		createAuthMiddleware: (
			...args: Parameters<typeof real.createAuthMiddleware>
		) => {
			const requireAuth = real.createAuthMiddleware(...args);
			return (
				req: import("express").Request,
				res: import("express").Response,
				next: import("express").NextFunction,
			) => {
				if (!MUTATE.signIn) return requireAuth(req, res, next);
				req.userId = "user-b";
				req.isAdmin = false;
				next();
			};
		},
	};
});
vi.mock("../src/monitor-token.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/monitor-token.js")>();
	return {
		...real,
		deriveMonitorToken: (missionId: string) =>
			MUTATE.missionToken
				? "not-the-token"
				: real.deriveMonitorToken(missionId),
	};
});
vi.mock("../src/auth-scope.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/auth-scope.js")>();
	return {
		ownerFilter: (caller: Parameters<typeof real.ownerFilter>[0]) =>
			MUTATE.tenantRule ? {} : real.ownerFilter(caller),
	};
});

const ROOT = join(__dirname, "..", "..", "..");
const SECRET = "tenant-a-private-marker";

interface Op {
	method: string;
	path: string;
	auth: string;
	operation?: string;
	forwards?: boolean;
}

function operations(): Op[] {
	const spec = JSON.parse(
		readFileSync(
			join(ROOT, "docs", "api", "control-plane.openapi.json"),
			"utf8",
		),
	);
	const ops: Op[] = [];
	for (const [path, item] of Object.entries<
		Record<string, Record<string, unknown>>
	>(spec.paths)) {
		for (const [method, op] of Object.entries(item)) {
			ops.push({
				method: method.toUpperCase(),
				path,
				auth: op["x-magi-auth"] as string,
				operation: op["x-magi-operation"] as string | undefined,
				forwards: Boolean(op["x-magi-forwards"]),
			});
		}
	}
	return ops;
}

/** Tenant A's world: a mission, its app, a schedule; B owns nothing. */
function world() {
	return fakeDb({
		missions: [
			{
				missionId: "m-a",
				userId: "user-a",
				name: SECRET,
				status: "running",
				privateIp: "fdaa::1",
				machineId: "mach-a",
				mission: { id: "m-a", name: SECRET, maxCostUsd: 10 },
				agents: [
					{
						id: "lead",
						supervisor: "user",
						systemPrompt: SECRET,
						initialMentalMap: "x",
					},
				],
				createdAt: new Date(0),
				updatedAt: new Date(0),
			},
		],
		missionApps: [
			{
				missionId: "m-a",
				name: "dash",
				capability: "c".repeat(32),
				status: "running",
				owner: "lead",
			},
		],
		scheduled_messages: [],
		mailbox: [],
		users: [],
		copilotPendingActions: [],
	});
}

/** Query parameters some routes read before they look the mission up. */
const QUERY: Record<string, string> = {
	"/llm-call": "?agent=lead&turn=1&i=0",
	"/llm-calls": "?agent=lead&turn=1",
	"/transcript": "?agent=lead&turn=1",
	"/turns": "?agent=lead",
	"/github/issues": "?missionId=m-a",
};

/** Bodies that pass a route's own validation, so the request reaches the mission lookup. */
const BODY: Record<string, unknown> = {
	"/limits/agent/{agentId}": { limits: null },
	"/limits/ceiling": { ceilingUsd: 5 },
	"/limits/mission": { maxCostUsd: 5 },
	"/messages/send": { to: "lead", body: "hi" },
	"/messages/read": { ids: ["x"] },
	"/api/apps/reopen": { capability: "c".repeat(32) },
};

function concretePath(path: string, missionId: string): string {
	const suffix = Object.keys(QUERY).find((k) => path.endsWith(k));
	return (
		path
			.replace("{id}", missionId)
			.replace("{name}", "dash")
			.replace("{agentId}", "lead")
			.replace("{rest}", "status")
			.replace(/\{[^}]+\}/g, "x") + (suffix ? QUERY[suffix] : "")
	);
}

function bodyFor(path: string): unknown {
	const key = Object.keys(BODY).find((k) => path.endsWith(k));
	return key ? BODY[key] : { missionId: "m-a", name: "dash" };
}

/** Every collection but `users` (sign-in records who called), for "nothing changed". */
function snapshot(data: Record<string, Doc[]>): string {
	const { users: _users, ...rest } = data;
	return JSON.stringify(rest);
}

type Result = { status: number; body: string; changed: boolean };

let base = "";
let close: () => void = () => {};
let current: ReturnType<typeof fakeDb>;

beforeAll(async () => {
	process.env.CONTROL_API_KEY = "admin-key-not-used-by-these-tests";
	process.env.MONITOR_SIGNING_KEY = "m".repeat(64);
	// Interactive apps configured, so their routes reach the mission lookup.
	process.env.APPS_HOST_URL = "https://apps.invalid";
	process.env.APPS_TICKET_KEY = "t".repeat(64);
	process.env.APPS_SIGNING_KEY = "s".repeat(64);
	const { createApp } = await import("../src/app.js");
	const inert: unknown = new Proxy(() => {}, {
		get: (_t, p) => (p === "then" ? undefined : inert),
		apply: () => inert,
	});
	current = world();
	// The db is swapped per request; the app reads it through this proxy.
	const db = new Proxy(
		{},
		{ get: (_t, p) => Reflect.get(current.db as object, p) },
	);
	const app = createApp({
		db: db as never,
		pendingActions: inert as never,
		copilotRuntime: inert as never,
		repoRoot: ROOT,
	});
	const server = app.listen(0, "127.0.0.1");
	await new Promise((r) => server.once("listening", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	close = () => server.close();
	// Importing and building the whole app is slow under the parallel suite's load.
}, 60_000);
afterAll(() => close());

async function send(
	op: Op,
	headers: Record<string, string>,
	missionId = "m-a",
): Promise<Result> {
	current = world();
	const before = snapshot(current.data as Record<string, Doc[]>);
	const res = await fetch(`${base}${concretePath(op.path, missionId)}`, {
		method: op.method,
		headers: { "content-type": "application/json", ...headers },
		body: ["GET", "HEAD", "DELETE"].includes(op.method)
			? undefined
			: JSON.stringify(bodyFor(op.path)),
		redirect: "manual",
		// A route that never answers (an event stream, a proxied machine that is not there)
		// counts as not refused: status 0.
		signal: AbortSignal.timeout(1_500),
	}).catch(
		(e: Error) =>
			({ status: 0, text: async () => e.message }) as unknown as Response,
	);
	const body = (
		await res.text().catch((e: Error) => `(no complete answer: ${e.message})`)
	).replaceAll(missionId, "<id>");
	return {
		status: res.status,
		body,
		changed: snapshot(current.data as Record<string, Doc[]>) !== before,
	};
}

/** B's answer for A's mission is B's answer for no mission at all, and nothing of A's moved. */
function indistinguishable(r: Result, none: Result): boolean {
	return (
		r.status === none.status &&
		r.body === none.body &&
		!r.body.includes(SECRET) &&
		!r.changed
	);
}

const OPS = operations();

describe(
	"attack matrix: control-plane HTTP cells",
	{ timeout: 120_000 },
	() => {
		it("is generated from a non-empty surface", () => {
			expect(OPS.length).toBeGreaterThan(50);
		});

		/** Runs a cell set; with `mutate`, returns the cells that still held (unproven). */
		async function authCells(
			ops: Op[],
			headers: Record<string, string>,
			refused: (status: number) => boolean,
		): Promise<string[]> {
			const held: string[] = [];
			for (const op of ops) {
				const r = await send(op, headers);
				if (refused(r.status) && !r.changed)
					held.push(`${op.method} ${op.path}`);
			}
			return held;
		}

		const operatorOps = OPS.filter((o) => o.auth === "operator");
		const tokenOps = OPS.filter((o) => o.auth === "monitor-token");
		const BAD_TOKEN = { "x-monitor-token": "not-the-token" };

		it("sec.authenticated: no-credential, every operator route (401, nothing written)", async () => {
			const held = await authCells(operatorOps, {}, (s) => s === 401);
			const broken = operatorOps
				.map((o) => `${o.method} ${o.path}`)
				.filter((k) => !held.includes(k));
			expect(broken).toEqual([]);
		});

		it("can fail: with sign-in replaced by a pass-through, every no-credential cell breaks", async () => {
			MUTATE.signIn = true;
			try {
				expect(await authCells(operatorOps, {}, (s) => s === 401)).toEqual([]);
			} finally {
				MUTATE.signIn = false;
			}
		});

		it("sec.authenticated: bad-mission-token, every mission-copilot route (401/403, nothing written)", async () => {
			const held = await authCells(
				tokenOps,
				BAD_TOKEN,
				(s) => s === 401 || s === 403,
			);
			const broken = tokenOps
				.map((o) => `${o.method} ${o.path}`)
				.filter((k) => !held.includes(k));
			expect(broken).toEqual([]);
		});

		it("can fail: with the mission token accepted whatever it is, every bad-token cell breaks", async () => {
			MUTATE.missionToken = true;
			try {
				expect(
					await authCells(tokenOps, BAD_TOKEN, (s) => s === 401 || s === 403),
				).toEqual([]);
			} finally {
				MUTATE.missionToken = false;
			}
		});

		describe("sec.tenant-scoped: other-tenant, every operator route naming a mission or an app", () => {
			const cells = OPS.filter(
				(o) =>
					o.auth === "operator" &&
					/^\/api\/missions\/\{id\}|^\/missions\/\{id\}|^\/api\/apps\//.test(
						o.path,
					),
			);
			const B = { authorization: "Bearer token-b" };
			const verdicts = new Map<
				string,
				{ held: boolean; testable: boolean; proven?: boolean; detail: string }
			>();

			it("tenant B learns nothing of tenant A's mission", async () => {
				for (const op of cells) {
					const asB = await send(op, B);
					const none = await send(op, B, "m-zz");
					const asOwner = await send(op, { authorization: "Bearer token-a" });
					verdicts.set(`${op.method} ${op.path}`, {
						held: indistinguishable(asB, none),
						// The owner gets what a stranger gets: the route refuses everyone here.
						testable: !indistinguishable(asOwner, none),
						detail: `B ${asB.status}, none ${none.status}, owner ${asOwner.status}${asB.changed ? ", wrote" : ""}${asB.body.includes(SECRET) ? ", leaked" : ""}`,
					});
				}
				const broken = [...verdicts]
					.filter(([, v]) => !v.held)
					.map(([k, v]) => `${k}: ${v.detail}`);
				expect(broken).toEqual([]);
			});

			it("can fail: with the tenant rule stubbed out, the cells it guards break", async () => {
				MUTATE.tenantRule = true;
				try {
					for (const op of cells) {
						const v = verdicts.get(`${op.method} ${op.path}`);
						if (!v?.testable) continue;
						const asB = await send(op, B);
						const none = await send(op, B, "m-zz");
						v.proven = !indistinguishable(asB, none);
					}
				} finally {
					MUTATE.tenantRule = false;
				}
				const list = (
					f: (v: { testable: boolean; proven?: boolean }) => boolean,
				) =>
					[...verdicts]
						.filter(([, v]) => f(v))
						.map(([k, v]) => `${k} (${v.detail})`);
				const proven = list((v) => v.testable && v.proven === true);
				const unproven = list((v) => v.testable && !v.proven);
				const untestable = list((v) => !v.testable);
				console.log(
					`[attack-matrix] other-tenant: ${proven.length} proven, ${unproven.length} unproven, ${untestable.length} untestable here` +
						`${unproven.length ? `\n unproven:\n  ${unproven.join("\n  ")}` : ""}` +
						`${untestable.length ? `\n untestable:\n  ${untestable.join("\n  ")}` : ""}`,
				);
				expect(unproven).toEqual([]);
				expect(proven.length).toBeGreaterThan(20);
			});
		});
	},
);
