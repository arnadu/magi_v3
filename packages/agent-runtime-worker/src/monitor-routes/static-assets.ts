import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIME } from "../monitor-server.js";
import type { RouteEntry } from "./types.js";

export interface StaticAssetsDeps {
	publicDir: string;
}

/** The cockpit dashboard's own static shell: page markup, styles, script. */
export function createStaticAssetsRoutes(deps: StaticAssetsDeps): RouteEntry[] {
	return [
		{
			method: "GET",
			path: ["/", "/index.html"],
			handler({ res }) {
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end(readFileSync(join(deps.publicDir, "index.html")));
			},
		},
		{
			method: "GET",
			path: ["/style.css", "/app.js"],
			handler({ url, res }) {
				const ext = url.slice(url.lastIndexOf(".")) as keyof typeof MIME;
				res.writeHead(200, {
					"Content-Type": MIME[ext],
					"Cache-Control": "no-store",
				});
				res.end(readFileSync(join(deps.publicDir, url)));
			},
		},
	];
}
