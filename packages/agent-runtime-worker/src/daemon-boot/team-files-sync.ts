import { mkdirSync } from "node:fs";
import { validateTeamFilePath } from "@magi/agent-config";
import { writeFileInside } from "../safe-path.js";
import type { BootContext } from "./context.js";

/**
 * Fetch team files from the mission document and write them to teamDir on
 * every boot. Stored in MongoDB before machine provisioning so they survive
 * restarts without requiring a size-limited env var payload. Non-fatal on
 * failure — a stale or missing skills dir shouldn't block mission boot.
 *
 * SECURITY (TF1/CHAIN-A, 2026-10-15 audit): `relPath` comes from
 * tenant-supplied and agent-authored config (`SaveMissionConfig`, three
 * control-plane routes, `save_session_config`). Every one of those callers
 * is supposed to reject a traversal before ever storing it, but this
 * function is what actually writes to disk as the daemon identity, so it
 * never trusts that upstream validation ran: each path is re-checked as a
 * string (rejects `..`/absolute paths outright), then written through
 * `writeFileInside` (realpath'd parents, `O_NOFOLLOW` on the file itself —
 * safe-path.ts). A bad entry is skipped and logged, not fatal to the rest
 * of the sync.
 */
export async function syncTeamFiles(
	ctx: Pick<BootContext, "db" | "missionId" | "teamDir">,
): Promise<Pick<BootContext, never>> {
	try {
		const missionDoc = await ctx.db
			.collection("missions")
			.findOne({ missionId: ctx.missionId }, { projection: { teamFiles: 1 } });
		const dbFiles = missionDoc?.teamFiles as
			| Array<{ path: string; content: string }>
			| undefined;
		if (dbFiles && dbFiles.length > 0) {
			mkdirSync(ctx.teamDir, { recursive: true });
			let written = 0;
			for (const { path: relPath, content } of dbFiles) {
				try {
					validateTeamFilePath(relPath);
					writeFileInside(ctx.teamDir, relPath, content);
					written++;
				} catch (e) {
					process.stderr.write(
						`[daemon] Rejected team file { path: ${JSON.stringify(relPath)}, error: "${(e as Error).message}" }\n`,
					);
				}
			}
			process.stdout.write(
				`[daemon] Wrote ${written} team files from MongoDB to ${ctx.teamDir}\n`,
			);
		}
	} catch (e) {
		process.stderr.write(
			`[daemon] Failed to write team files from MongoDB: ${(e as Error).message}\n`,
		);
	}
	return {};
}
