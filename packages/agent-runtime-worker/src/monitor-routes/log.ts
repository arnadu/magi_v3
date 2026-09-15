import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteEntry } from "./types.js";

export interface LogRoutesDeps {
	workdir: string;
}

/** GET /log — tail of daemon.log, capped at 2000 lines. */
export function createLogRoutes(deps: LogRoutesDeps): RouteEntry[] {
	return [
		{
			method: "GET",
			path: "/log",
			handler({ rawUrl, res }) {
				const logPath = join(deps.workdir, "daemon.log");
				const maxLines = Math.min(
					Number.parseInt(
						new URL(rawUrl, "http://x").searchParams.get("lines") ?? "200",
						10,
					) || 200,
					2000,
				);
				let body = "";
				if (existsSync(logPath)) {
					const content = readFileSync(logPath, "utf8");
					const lines = content.split("\n");
					body = lines.slice(-maxLines).join("\n");
				}
				res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
				res.end(body);
			},
		},
	];
}
