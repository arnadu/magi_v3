/**
 * Who wrote a request file an agent dropped into a shared directory (jobs,
 * schedules, apps; ADR-0033). The file's owner uid is the author, so the
 * file is refused when that cannot be trusted: a symlink, anything but a
 * regular file, a hard link (another agent's file under a new name), a file
 * owned by the daemon (renamed or planted), or an owner who is not an agent
 * of this mission. Checked with `lstat`, so a link is never followed.
 */

import { lstatSync } from "node:fs";

export interface OwnerCheckDeps {
	/** The daemon's own uid: a file it owns was not written by an agent. */
	daemonUid: number;
	/** Each agent's OS uid → its agent id (`buildUidToAgentId`). */
	uidToAgentId: ReadonlyMap<number, string>;
	/** Test seam: the owner uid of a path, instead of `lstat`'s. */
	ownerUidOf?: (path: string) => number;
}

export type OwnedFile =
	| { kind: "owned"; owner: string }
	/** Removed between the directory listing and the check. */
	| { kind: "gone" }
	| { kind: "refused"; reason: string };

export function ownerOfRequestFile(
	path: string,
	maxBytes: number,
	deps: OwnerCheckDeps,
): OwnedFile {
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(path);
	} catch {
		return { kind: "gone" };
	}
	const refused = (reason: string): OwnedFile => ({ kind: "refused", reason });
	if (st.isSymbolicLink()) return refused("symlink");
	if (!st.isFile()) return refused("not a regular file");
	if (st.nlink > 1) return refused("hard link");
	if (st.size > maxBytes) return refused("file too large");
	const uid = deps.ownerUidOf ? deps.ownerUidOf(path) : st.uid;
	if (uid === deps.daemonUid)
		return refused(
			"owned by the daemon (renamed or planted, not written by an agent)",
		);
	const owner = deps.uidToAgentId.get(uid);
	if (!owner)
		return refused(`owner uid ${uid} is not an agent of this mission`);
	return { kind: "owned", owner };
}
