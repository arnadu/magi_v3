import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteEntry } from "./types.js";

export interface UploadDownloadDeps {
	handleUpload: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
	handleDownload: (rawUrl: string, res: ServerResponse) => void;
}

/**
 * POST /upload — operator uploads a file; it is processed and a mailbox
 * message is posted to the target agent. GET /download — stream a file, or
 * a folder subtree as a zip. Both thin delegations to still-private
 * MonitorServer methods, passed through as bound callbacks.
 */
export function createUploadDownloadRoutes(
	deps: UploadDownloadDeps,
): RouteEntry[] {
	return [
		{
			method: "POST",
			path: "/upload",
			async handler({ req, res }) {
				await deps.handleUpload(req, res);
			},
		},
		{
			method: "GET",
			path: "/download",
			handler({ rawUrl, res }) {
				deps.handleDownload(rawUrl, res);
			},
		},
	];
}
