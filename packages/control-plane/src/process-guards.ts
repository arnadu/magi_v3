/**
 * Last-resort handlers for the control plane process (audit C1).
 *
 * Without these, a rejected promise nobody awaited — an Express 4 async
 * handler was the common case before `asyncHandler` — printed a warning on
 * Node 18 and terminates the process on Node 22 (`--unhandled-rejections=
 * throw` is the default), taking every tenant's API, proxy and scheduler
 * down with it. A rejection is logged with enough context to find it; an
 * uncaught exception still exits (the process state is unknown) but says
 * why first, and Fly restarts the machine.
 */

import type { NextFunction, Request, Response } from "express";

export function installProcessGuards(
	log: Pick<Console, "error"> = console,
): void {
	process.on("unhandledRejection", (reason) => {
		const err = reason instanceof Error ? reason : new Error(String(reason));
		log.error(
			`[control-plane] unhandled promise rejection { error: ${JSON.stringify(err.message)} } — the originating request (if any) got no response; the process continues\n${err.stack ?? ""}`,
		);
	});
	process.on("uncaughtException", (err) => {
		log.error(
			`[control-plane] uncaught exception { error: ${JSON.stringify(err.message)} } — exiting; Fly restarts the machine\n${err.stack ?? ""}`,
		);
		process.exit(1);
	});
}

/**
 * Terminal Express error middleware: every `next(err)` (from `asyncHandler`
 * or a synchronous throw) ends here with a JSON 500 instead of a hung
 * request. The message is logged, not echoed — handler errors routinely
 * quote internal paths and upstream bodies.
 */
export function errorMiddleware(log: Pick<Console, "error"> = console) {
	return (
		err: unknown,
		req: Request,
		res: Response,
		_next: NextFunction,
	): void => {
		const e = err instanceof Error ? err : new Error(String(err));
		log.error(
			`[control-plane] request failed { method: ${req.method}, path: ${JSON.stringify(req.path)}, userId: ${JSON.stringify(req.userId ?? null)}, error: ${JSON.stringify(e.message)} } — client receives 500\n${e.stack ?? ""}`,
		);
		if (res.headersSent) {
			res.end();
			return;
		}
		res.status(500).json({ error: "Internal server error" });
	};
}
