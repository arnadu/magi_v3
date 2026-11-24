/**
 * Express 4 does not catch a rejected promise from an `async` handler: the
 * request hangs and, with no `unhandledRejection` listener, the process can
 * die (audit C1). Every async route goes through this wrapper so a rejection
 * (or a synchronous throw) becomes `next(err)` and reaches the error
 * middleware. The T7 tripwire counts bare `router.*(…, async (req, res)`
 * registrations and only ratchets down; files register through
 * `asyncRoutes(router)` instead, which cannot forget the wrapper.
 */

import type { EntryTag } from "@magi/agent-config";
import type { NextFunction, Request, RequestHandler, Response } from "express";

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

export function asyncHandler(fn: Handler): RequestHandler {
	return (req, res, next) => {
		Promise.resolve()
			.then(() => fn(req, res, next))
			.catch(next);
	};
}

type Verb = "get" | "post" | "put" | "patch" | "delete";
type Method = Verb | "use";
export type AsyncRoutes = Record<
	Verb,
	(path: string, operation: EntryTag, ...handlers: RequestHandler[]) => void
> & { use: (path: string, ...handlers: RequestHandler[]) => void };

/**
 * Declares the operation a route registered directly on a router serves,
 * as its first handler: `router.get("/x", operation("mission.status"), h)`.
 * It does nothing at run time; the entry-point scan reads the tag. Routes
 * registered through `asyncRoutes` pass the tag as an argument instead.
 */
/**
 * The operation a marker middleware names (read by api-surface.ts, which lists the API).
 * A registered symbol, so the apps host's own marker carries the same key without importing this.
 */
export const OPERATION = Symbol.for("magi.operation");
/** Paths given to `asyncRoutes(...).use(path, ...)`, by router: Express 5 keeps no mount path. */
export const USE_PATHS = new WeakMap<object, string[]>();

export function operation(tag: EntryTag): RequestHandler {
	const marker: RequestHandler = (_req, _res, next) => next();
	Object.defineProperty(marker, OPERATION, { value: tag });
	return marker;
}

/**
 * A router's registration methods with the last handler wrapped in
 * `asyncHandler`. Middlewares before the handler (e.g. `express.json()`) are
 * passed through untouched. Every route names the operation it serves
 * (ADR-0036); `use` mounts middleware and names none.
 */
export function asyncRoutes(
	router: {
		[M in Method]: (path: string, ...handlers: RequestHandler[]) => unknown;
	},
): AsyncRoutes {
	const wrap =
		(method: Method) =>
		(path: string, ...handlers: RequestHandler[]): void => {
			const last = handlers[handlers.length - 1];
			if (!last) throw new Error(`asyncRoutes.${method}(${path}): no handler`);
			router[method](path, ...handlers.slice(0, -1), asyncHandler(last));
		};
	const route =
		(verb: Verb) =>
		(path: string, tag: EntryTag, ...handlers: RequestHandler[]) =>
			wrap(verb)(path, operation(tag), ...handlers);
	const use = (path: string, ...handlers: RequestHandler[]): void => {
		USE_PATHS.set(router, [...(USE_PATHS.get(router) ?? []), path]);
		wrap("use")(path, ...handlers);
	};
	return {
		get: route("get"),
		post: route("post"),
		put: route("put"),
		patch: route("patch"),
		delete: route("delete"),
		use,
	};
}

/**
 * A named route parameter (`:id`). Express 5 types every parameter as
 * `string | string[]` (wildcard parameters are arrays); a named one is always
 * a string, and anything else is refused rather than coerced.
 */
export function routeParam(req: Request, name: string): string {
	const v = req.params[name];
	if (typeof v !== "string")
		throw new Error(`route parameter ${name} is not a single value`);
	return v;
}
