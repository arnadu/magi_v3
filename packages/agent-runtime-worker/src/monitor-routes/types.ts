import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Everything a route handler needs about the current request. `url` is the
 * path with any query string already stripped (matches handleRequest's own
 * pre-split `url` local) — handlers that need query params read them from
 * `rawUrl` themselves via `new URL(rawUrl, "http://x")`, matching the
 * pattern several routes already use.
 */
export interface RequestCtx {
	req: IncomingMessage;
	res: ServerResponse;
	rawUrl: string;
	url: string;
}

/**
 * One dispatch table entry. `path` is a literal (or a short list of literal
 * aliases, for routes like `/` / `/index.html` that currently match via
 * `||`) for an exact-match route, or a RegExp for a route with URL
 * parameters — capture groups are passed to `handler` as extra string
 * arguments, `decodeURIComponent`-ed, matching handleRequest's existing
 * per-route decoding.
 */
export interface RouteEntry {
	method: "GET" | "POST" | "DELETE";
	path: string | string[] | RegExp;
	handler: (ctx: RequestCtx, ...params: string[]) => Promise<void> | void;
}
