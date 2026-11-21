import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { RouteEntry } from "./types.js";

/**
 * What the monitor server needs of interactive apps (ADR-0037), set by the
 * daemon once apps have started; undefined until then.
 */
export interface MonitorApps {
	/** The hop to the apps themselves (`/a/<capability>/`), with its own auth. */
	hop: {
		owns(url: string): boolean;
		http(req: IncomingMessage, res: ServerResponse): void;
		upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
	};
	/** Every app of the mission, as agents and the operator may see it (no capability). */
	list(): Promise<unknown[]>;
	/** The operator starts, stops or removes an app (operation app.control). */
	control(
		name: string,
		action: "start" | "stop" | "remove",
	): Promise<{ ok: boolean; message: string }>;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
};

/** GET /apps and POST /apps/:name/(start|stop|remove), for the cockpit and the control plane. */
export function createAppRoutes(
	apps: () => MonitorApps | undefined,
): RouteEntry[] {
	return [
		{
			method: "GET",
			path: "/apps",
			operation: "app.status",
			async handler({ res }) {
				const a = apps();
				json(res, 200, a ? await a.list() : []);
			},
		},
		{
			method: "POST",
			path: /^\/apps\/([a-z][a-z0-9-]{0,39})\/(start|stop|remove)$/,
			operation: "app.control",
			async handler({ res }, name, action) {
				const a = apps();
				if (!a)
					return json(res, 503, {
						ok: false,
						message: "apps are not running yet",
					});
				const r = await a.control(name, action as "start" | "stop" | "remove");
				json(res, r.ok ? 200 : 409, r);
			},
		},
	];
}
