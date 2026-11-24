/**
 * The HTTP surfaces as OpenAPI files (docs/api/*.openapi.json), read from the code as built:
 * the control plane's app (createApp), the apps host, the monitor server's route table and the
 * Tool API's names. The files are compared, not hand-edited: after a route change, run
 * `npm run docs:api` (UPDATE_API_DOC=1) and commit the result.
 *
 * The contract enforced on every route: it names its operation, and an operation the catalog
 * defines; it is public only if listed below with the reason.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseline } from "@magi/agent-config";
import express from "express";
import { describe, expect, it } from "vitest";
// From the build, not src/: constructing these servers would load their integration-tested
// code into the unit coverage count; the build is current whenever `npm run verify` runs tests.
import { MonitorServer } from "../../agent-runtime-worker/dist/monitor-server.js";
import { ToolApiServer } from "../../agent-runtime-worker/dist/tool-api-server.js";
import { apiSurface, mount } from "../src/api-surface.js";
import { createApp } from "../src/app.js";
import { createAppsHost } from "../src/apps-host/server.js";
import { asyncRoutes, operation } from "../src/async-handler.js";
import {
	type SurfaceDoc,
	type SurfaceRoute,
	templateFromRegExp,
	toOpenApi,
} from "./support/openapi.js";

const ROOT = join(__dirname, "..", "..", "..");

/** Stand-in for every dependency: building the apps must touch no database or runtime. */
const inert: unknown = new Proxy(() => {}, {
	get: (_t, p) => (p === "then" ? undefined : inert),
	apply: () => inert,
	construct: () => inert as object,
});

/** Routes that answer without a credential, and why each may. */
const PUBLIC: Record<string, string> = {
	"GET /healthz": "Fly's liveness check; answers nothing about any mission",
	"GET /firebase-config.js": "the sign-in page's public Firebase client values",
	"POST /api/csp-report":
		"browsers post CSP violation reports without credentials",
	"GET /t/:ticket":
		"apps host: redeems a 60-second signed ticket (the ticket is the credential)",
	"* /a/:capability":
		"apps host: the app session cookie is checked inside the route",
	"* /a/:capability/*rest":
		"apps host: the app session cookie is checked inside the route",
};

const KNOWN = new Set<string>([
	...baseline.OPERATIONS.map((o) => o.id),
	...baseline.ENTRY_CLASSES.map((c) => c.id),
]);

function controlPlane(): SurfaceDoc {
	const app = createApp({
		db: inert as never,
		pendingActions: inert as never,
		copilotRuntime: inert as never,
		repoRoot: ROOT,
	});
	const routes: SurfaceRoute[] = apiSurface(app).map((r) => ({
		...r,
		...(r.forwards
			? {
					forwards:
						"the mission's monitor server (monitor.openapi.json), with the mission's monitor token added",
				}
			: {}),
	}));
	return {
		title: "MAGI control plane",
		description:
			"The cockpit's API and the mission-copilot proxy (Express, magi-control-<suffix>.fly.dev).",
		auth: {
			public: {
				schemes: [],
				description:
					"no credential (listed, with the reason, in the contract test)",
			},
			operator: {
				schemes: ["operatorBearer", "operatorSession"],
				description:
					"a signed-in operator (Firebase ID token or session cookie) or the admin key; every mission route is then scoped to the operator's own missions",
			},
			"monitor-token": {
				schemes: ["monitorToken"],
				description:
					"a mission machine's per-mission monitor token (the mission copilot's calls)",
			},
		},
		schemes: {
			operatorBearer: {
				type: "http",
				scheme: "bearer",
				description: "Firebase ID token, or CONTROL_API_KEY",
			},
			operatorSession: {
				type: "apiKey",
				in: "cookie",
				name: "magi_session",
				description: "the cockpit's session cookie",
			},
			monitorToken: {
				type: "apiKey",
				in: "header",
				name: "x-monitor-token",
				description: "per-mission token derived from MONITOR_SIGNING_KEY",
			},
		},
		routes,
	};
}

function appsHost(): SurfaceDoc {
	const { app } = createAppsHost({
		ticketKey: "k",
		signingKey: "k",
		cockpitUrl: "https://cockpit.invalid",
		onFly: false,
	});
	const routes = apiSurface(app).map((r) => ({ ...r, auth: "public" }));
	return {
		title: "MAGI apps host",
		description:
			"Serves the operator's interactive apps on a site of their own (magi-apps-<suffix>.fly.dev, ports 20000-20099; ADR-0037).",
		auth: {
			public: {
				schemes: [],
				description:
					"no API credential: a signed ticket in the path, or the app's session cookie, checked by the route",
			},
		},
		schemes: {},
		routes,
	};
}

function monitor(): SurfaceDoc {
	const server = new MonitorServer(
		...(Array(14).fill(inert) as ConstructorParameters<typeof MonitorServer>),
	);
	const routes: SurfaceRoute[] = [];
	for (const r of server.routeTable()) {
		const paths = Array.isArray(r.path) ? r.path : [r.path];
		for (const p of paths) {
			if (typeof p === "string")
				routes.push({
					method: r.method,
					path: p,
					operation: r.operation,
					auth: "monitor",
				});
			else {
				const t = templateFromRegExp(p);
				routes.push({
					method: r.method,
					path: t ?? `/{unreadable-pattern}`,
					operation: r.operation,
					auth: "monitor",
					pattern: p.source,
				});
			}
		}
	}
	// The app hop is matched before the route table, with its own credential (app-hop.ts).
	routes.push({
		method: "*",
		path: "/a/{capability}/{rest}",
		operation: "app.open",
		auth: "apps",
		pattern: "^\\/a\\/([0-9a-f]{32})(\\/|$)",
	});
	return {
		title: "MAGI monitor server",
		description:
			"A mission machine's port 4000, reached over Fly's private network: by the control plane's proxy (the cockpit), the control plane itself, and the apps host's hop.",
		auth: {
			monitor: {
				schemes: ["monitorToken"],
				description:
					"the per-mission monitor token, required on every route (GETs and SSE included) whenever MONITOR_TOKEN is set, which is always on Fly",
			},
			apps: {
				schemes: ["appsToken"],
				description:
					"the apps host's per-mission apps token with the mission id; the monitor token is refused here",
			},
		},
		schemes: {
			monitorToken: {
				type: "apiKey",
				in: "header",
				name: "x-monitor-token",
				description: "per-mission token derived from MONITOR_SIGNING_KEY",
			},
			appsToken: {
				type: "apiKey",
				in: "header",
				name: "x-apps-token",
				description:
					"per-mission token derived from APPS_SIGNING_KEY, with x-apps-mission",
			},
		},
		routes,
	};
}

function toolApi(): SurfaceDoc {
	const server = new ToolApiServer(
		...(Array(8).fill(inert) as ConstructorParameters<typeof ToolApiServer>),
	);
	return {
		title: "MAGI Tool API",
		description:
			"A mission machine's port 4001 on loopback: background jobs call the platform's tools as the agent that started them.",
		auth: {
			job: {
				schemes: ["jobToken"],
				description:
					"the job's MAGI_TOOL_TOKEN, issued for one job and revoked when it ends",
			},
		},
		schemes: {
			jobToken: {
				type: "http",
				scheme: "bearer",
				description: "MAGI_TOOL_TOKEN",
			},
		},
		routes: server.toolNames().map((t) => ({
			method: "POST",
			path: `/tools/${t.name}`,
			operation: t.operation,
			auth: "job",
		})),
	};
}

/** What breaks the contract: a route with no operation or one the catalog lacks, an unlisted public route. */
function contractProblems(routes: SurfaceRoute[]): string[] {
	const problems: string[] = [];
	for (const r of routes) {
		const key = `${r.method} ${r.path}`;
		if (!r.forwards && !r.operation) problems.push(`${key}: no operation`);
		if (r.operation && !KNOWN.has(r.operation))
			problems.push(`${key}: "${r.operation}" is not in the catalog`);
		if (r.auth === "public" && !PUBLIC[key])
			problems.push(`${key}: public, and not listed in PUBLIC with a reason`);
	}
	return problems;
}

const SURFACES: Record<string, () => SurfaceDoc> = {
	"control-plane": controlPlane,
	"apps-host": appsHost,
	monitor,
	"tool-api": toolApi,
};

describe("the HTTP surfaces (docs/api)", () => {
	for (const [name, build] of Object.entries(SURFACES)) {
		describe(name, () => {
			const doc = build();

			it("sec.authenticated: every route names a catalog operation, and is public only with a listed reason", () => {
				expect(contractProblems(doc.routes)).toEqual([]);
				expect(doc.routes.length).toBeGreaterThan(0);
			});

			it(`docs/api/${name}.openapi.json is current (npm run docs:api)`, () => {
				const path = join(ROOT, "docs", "api", `${name}.openapi.json`);
				const rendered = `${JSON.stringify(toOpenApi(doc), null, "\t")}\n`;
				if (process.env.UPDATE_API_DOC === "1") {
					mkdirSync(join(ROOT, "docs", "api"), { recursive: true });
					writeFileSync(path, rendered);
				}
				expect(readFileSync(path, "utf8")).toBe(rendered);
			});
		});
	}
});

describe("the surface reader and the contract catch what they must (planted app)", () => {
	it("records mounts, operations and authentication, and flags an unmarked, unknown or unlisted route", () => {
		const app = express();
		app.get("/healthz", operation("infrastructure"), (_q, r) => r.end());
		app.get("/debug", (_q, r) => r.end()); // public, unlisted, no operation
		const router = express.Router();
		const routes = asyncRoutes(router);
		routes.get("/:id", "mission.status", (_q, r) => r.end());
		routes.post("/:id/odd", "not.an-operation" as never, (_q, r) => r.end());
		routes.use("/:id/proxy", (_q, r) => r.end());
		mount(app, "/api/missions", "operator", router);

		const surface = apiSurface(app);
		expect(surface).toEqual(
			expect.arrayContaining([
				{
					method: "GET",
					path: "/healthz",
					operation: "infrastructure",
					auth: "public",
				},
				{
					method: "GET",
					path: "/api/missions/:id",
					operation: "mission.status",
					auth: "operator",
				},
				{
					method: "*",
					path: "/api/missions/:id/proxy",
					operation: null,
					auth: "operator",
					forwards: true,
				},
			]),
		);
		expect(contractProblems(surface).sort()).toEqual([
			"GET /debug: no operation",
			"GET /debug: public, and not listed in PUBLIC with a reason",
			'POST /api/missions/:id/odd: "not.an-operation" is not in the catalog',
		]);
	});
});
