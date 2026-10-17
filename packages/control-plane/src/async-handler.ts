/**
 * Express 4 does not catch a rejected promise from an `async` handler: the
 * request hangs and, with no `unhandledRejection` listener, the process can
 * die (audit C1). Every async route goes through this wrapper so a rejection
 * (or a synchronous throw) becomes `next(err)` and reaches the error
 * middleware. The T7 tripwire counts bare `router.*(…, async (req, res)`
 * registrations and only ratchets down; files register through
 * `asyncRoutes(router)` instead, which cannot forget the wrapper.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

export function asyncHandler(fn: Handler): RequestHandler {
	return (req, res, next) => {
		Promise.resolve()
			.then(() => fn(req, res, next))
			.catch(next);
	};
}

type Method = "get" | "post" | "put" | "patch" | "delete" | "use";
export type AsyncRoutes = Record<
	Method,
	(path: string, ...handlers: RequestHandler[]) => void
>;

/**
 * A router's registration methods with the last handler wrapped in
 * `asyncHandler`. Middlewares before the handler (e.g. `express.json()`) are
 * passed through untouched.
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
	return {
		get: wrap("get"),
		post: wrap("post"),
		put: wrap("put"),
		patch: wrap("patch"),
		delete: wrap("delete"),
		use: wrap("use"),
	};
}
