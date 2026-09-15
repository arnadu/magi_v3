import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteEntry } from "./types.js";

export interface FileEditDeps {
	handleFileEdit: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

/**
 * POST /files/shared/edit — the cockpit operator's text editor. Deliberately
 * separate from file-browsing.ts's /files/shared/write: this route commits
 * immediately and notifies the file's last-touching agent (see
 * handleFileEdit's own doc comment on monitor-server.ts for the full
 * rationale), unlike the copilot's mid-turn write.
 */
export function createFileEditRoutes(deps: FileEditDeps): RouteEntry[] {
	return [
		{
			method: "POST",
			path: "/files/shared/edit",
			async handler({ req, res }) {
				await deps.handleFileEdit(req, res);
			},
		},
	];
}
