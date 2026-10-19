import { unlinkSync } from "node:fs";

/**
 * Delete a file that may already be gone. A missing file is the expected
 * case and is silent; any other failure is logged with what it leaves behind,
 * because a leftover marker (a running-job or pid file) changes what the next
 * startup does.
 */
export function removeIfExists(path: string, leftover: string): void {
	try {
		unlinkSync(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
		console.error(
			`[fs] could not remove ${path}: ${(e as Error).message} — ${leftover}`,
		);
	}
}
