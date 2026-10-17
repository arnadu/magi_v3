/**
 * Express 4 does not catch a rejected promise from an `async` handler: the
 * request hangs and, with no `unhandledRejection` listener, the process can
 * die (audit C1). Every async route goes through this wrapper so a rejection
 * becomes `next(err)` and reaches the error middleware. The T7 tripwire
 * counts bare `async (req, res)` handlers and only ratchets down.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

export function asyncHandler(
	fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
	return (req, res, next) => {
		fn(req, res, next).catch(next);
	};
}
