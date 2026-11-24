/**
 * The control plane's HTTP surface, as data: every route with its method, full path, the
 * operation it serves and the authentication in force. It is read from the app as built
 * (`createApp`), not written by hand, so the OpenAPI file generated from it cannot drift from
 * the code; a test regenerates it and compares.
 *
 * Express 5 keeps the path of a route but not of a mount, so prefixes are recorded by
 * `mount()`; a route's operation comes from its `operation()` marker (asyncRoutes adds one).
 */
import { METHODS } from "node:http";
import type { Express, RequestHandler } from "express";
import { OPERATION, USE_PATHS } from "./async-handler.js";

/** How a request to the route is authenticated. */
export type ApiAuth =
	/** No credential: the login page, health, the CSP report. */
	| "public"
	/** A mission machine's per-mission monitor token (the mission-copilot proxy). */
	| "monitor-token"
	/** A signed-in operator (Firebase session or bearer) or the admin key: requireAuth. */
	| "operator";

export interface ApiRoute {
	method: string;
	path: string;
	operation: string | null;
	auth: ApiAuth;
	/** A pass-through to the monitor server (the proxy), not a route of its own. */
	forwards?: true;
}

interface Mount {
	path: string;
	auth: ApiAuth;
	handlers: RequestHandler[];
}

const MOUNTS = new WeakMap<Express, Mount[]>();

/** `app.use(path, ...handlers)`, recording the prefix and the authentication in force. */
export function mount(
	app: Express,
	path: string,
	auth: ApiAuth,
	...handlers: RequestHandler[]
): void {
	app.use(path, ...handlers);
	MOUNTS.set(app, [...(MOUNTS.get(app) ?? []), { path, auth, handlers }]);
}

interface LayerLike {
	route?: {
		path: unknown;
		/** Set by Express at runtime; not in its type declarations. */
		methods?: Record<string, boolean>;
		stack: { handle: unknown }[];
	};
	handle?: unknown;
}

function joinPath(prefix: string, path: string): string {
	const p = `${prefix.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
	return p.length > 1 ? p.replace(/\/$/, "") : p;
}

/** `app.all()` registers every method Node knows (Express 5) or `_all` (Express 4): "any". */
function methodsOf(methods: Record<string, boolean>): string[] {
	const names = Object.keys(methods);
	if (methods._all || METHODS.every((m) => names.includes(m.toLowerCase())))
		return ["*"];
	return names.map((m) => m.toUpperCase());
}

function operationOf(stack: { handle: unknown }[]): string | null {
	for (const { handle } of stack) {
		const tag = (handle as Record<symbol, unknown> | undefined)?.[OPERATION];
		if (typeof tag === "string") return tag;
	}
	return null;
}

function routesOfRouter(
	router: unknown,
	prefix: string,
	auth: ApiAuth,
): ApiRoute[] {
	const out: ApiRoute[] = [];
	const stack = (router as { stack?: LayerLike[] }).stack ?? [];
	for (const layer of stack) {
		if (layer.route && typeof layer.route.path === "string") {
			const op = operationOf(layer.route.stack);
			for (const m of methodsOf(layer.route.methods ?? {})) {
				out.push({
					method: m,
					path: joinPath(prefix, layer.route.path),
					operation: op,
					auth,
				});
			}
		} else if ((layer.handle as { stack?: unknown })?.stack) {
			// A sub-router mounted without a path (paths on router-level use() are recorded below).
			out.push(...routesOfRouter(layer.handle, prefix, auth));
		}
	}
	for (const path of USE_PATHS.get(router as object) ?? []) {
		out.push({
			method: "*",
			path: joinPath(prefix, path),
			operation: null,
			auth,
			forwards: true,
		});
	}
	return out;
}

/**
 * Every route of the app. Routes registered on the app itself (the public surface) are
 * public; everything else is reached through a recorded mount, with its authentication.
 */
export function apiSurface(app: Express): ApiRoute[] {
	const appStack: readonly LayerLike[] = app.router.stack;
	const routes: ApiRoute[] = [];
	for (const layer of appStack) {
		if (layer.route && typeof layer.route.path === "string") {
			const op = operationOf(layer.route.stack);
			for (const m of methodsOf(layer.route.methods ?? {})) {
				routes.push({
					method: m,
					path: layer.route.path,
					operation: op,
					auth: "public",
				});
			}
		}
	}
	for (const m of MOUNTS.get(app) ?? []) {
		for (const h of m.handlers)
			routes.push(...routesOfRouter(h, m.path, m.auth));
	}
	return routes.sort(
		(a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
	);
}
