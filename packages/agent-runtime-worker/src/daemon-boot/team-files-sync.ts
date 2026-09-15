import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BootContext } from "./context.js";

/**
 * Fetch team files from the mission document and write them to teamDir on
 * every boot. Stored in MongoDB before machine provisioning so they survive
 * restarts without requiring a size-limited env var payload. Non-fatal on
 * failure — a stale or missing skills dir shouldn't block mission boot.
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
			let written = 0;
			for (const { path: relPath, content } of dbFiles) {
				const dest = join(ctx.teamDir, relPath);
				mkdirSync(dirname(dest), { recursive: true });
				writeFileSync(dest, content);
				written++;
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
