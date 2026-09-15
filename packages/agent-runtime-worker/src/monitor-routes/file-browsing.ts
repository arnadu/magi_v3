import type { ServerResponse } from "node:http";
import { readBody } from "../monitor-server.js";
import type { RouteEntry } from "./types.js";

export interface FileBrowsingDeps {
	sharedDir: string;
	/**
	 * A getter, not the Map itself — `setAgentWorkdirs()` (called once
	 * workspace provisioning finishes, after this cluster's deps object is
	 * built) *replaces* the field's reference rather than mutating it in
	 * place. Capturing the Map by value here would pin the empty pre-
	 * provisioning Map for the process's whole lifetime.
	 */
	getAgentWorkdirs: () => Map<string, string>;
	serveFilePath: (root: string, userPath: string, res: ServerResponse) => void;
	serveFileHistory: (userPath: string, res: ServerResponse) => Promise<void>;
	writeFilePath: (root: string, rawBody: string, res: ServerResponse) => void;
}

function agentWorkdirOr404(
	deps: FileBrowsingDeps,
	agentId: string,
	res: ServerResponse,
): string | undefined {
	const root = deps.getAgentWorkdirs().get(agentId);
	if (!root) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Agent workdir not found" }));
	}
	return root;
}

/**
 * Read/write access to sharedDir and per-agent workdirs. `/files/shared/edit`
 * (the cockpit's own text editor, with commit+notify) is a separate cluster —
 * see file-edit.ts — despite sharing `sharedDir` with these routes.
 */
export function createFileBrowsingRoutes(deps: FileBrowsingDeps): RouteEntry[] {
	return [
		{
			method: "GET",
			path: "/files/shared",
			handler({ rawUrl, res }) {
				const userPath =
					new URL(rawUrl, "http://x").searchParams.get("path") ?? "";
				deps.serveFilePath(deps.sharedDir, userPath, res);
			},
		},
		{
			method: "GET",
			path: "/files/history",
			async handler({ rawUrl, res }) {
				const userPath =
					new URL(rawUrl, "http://x").searchParams.get("path") ?? "";
				await deps.serveFileHistory(userPath, res);
			},
		},
		{
			method: "GET",
			path: /^\/files\/workdir\/([^/]+)$/,
			handler({ rawUrl, res }, agentId) {
				const root = agentWorkdirOr404(deps, agentId, res);
				if (!root) return;
				const userPath =
					new URL(rawUrl, "http://x").searchParams.get("path") ?? "";
				deps.serveFilePath(root, userPath, res);
			},
		},
		{
			method: "POST",
			path: "/files/shared/write",
			async handler({ req, res }) {
				const body = await readBody(req);
				deps.writeFilePath(deps.sharedDir, body, res);
			},
		},
		{
			method: "POST",
			path: /^\/files\/workdir\/([^/]+)\/write$/,
			async handler({ req, res }, agentId) {
				const root = agentWorkdirOr404(deps, agentId, res);
				if (!root) return;
				const body = await readBody(req);
				deps.writeFilePath(root, body, res);
			},
		},
	];
}
