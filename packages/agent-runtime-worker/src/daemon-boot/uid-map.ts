import {
	closeSync,
	constants,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Agent OS users are recreated on every boot (the machine's root disk is
 * rebuilt), but the files they own live on the mission volume under numeric
 * uids. A user created with the next free uid gets a different one whenever the
 * roster or its order changes, and then owns, and is granted by ACL, another
 * agent's files. The uid map pins each agent user's uid for the life of the
 * volume: it is written before any user is created, and a uid is never handed
 * to another name, even after its agent leaves the roster.
 *
 * Only uids are pinned. A per-user group's gid can drift harmlessly: under the
 * workspace's default ACLs the owning group gets nothing in a private workdir
 * and only what "other" gets in shared/.
 */
export const UID_MAP_FILE = ".agent-uids.json";
export const FIRST_AGENT_UID = 1001;
/** Below the image's fixed users (pool users 60001+, mission-copilot 60011). */
export const LAST_AGENT_UID = 59999;

export type UidMap = Record<string, number>;

export interface UidPlan {
	/** The map to persist: the stored entries plus every newly assigned user. */
	map: UidMap;
	/** Users to create, each with its pinned uid. */
	create: Array<{ user: string; uid: number }>;
	/** Existing users whose uid differs from the map: never safe to run. */
	mismatched: Array<{ user: string; pinned: number; actual: number }>;
}

/**
 * Decide each user's uid. `existingUid` is the uid of a user that already
 * exists on this boot (one the image created, like mission-copilot) and
 * `uidTaken` whether any account holds a uid. Pure, so it can be tested.
 */
export function planUids(
	stored: UidMap,
	users: readonly string[],
	existingUid: (user: string) => number | undefined,
	uidTaken: (uid: number) => boolean,
): UidPlan {
	const map: UidMap = { ...stored };
	const create: UidPlan["create"] = [];
	const mismatched: UidPlan["mismatched"] = [];
	const used = new Set(Object.values(map));
	// Users the image creates (mission-copilot) sit above the range and are
	// only recorded; new agents are numbered after the highest agent uid.
	const inRange = [...used].filter((u) => u <= LAST_AGENT_UID);
	let next = Math.max(FIRST_AGENT_UID - 1, ...inRange) + 1;
	for (const user of users) {
		const actual = existingUid(user);
		const pinned = map[user];
		if (actual !== undefined) {
			if (pinned === undefined) {
				map[user] = actual;
				used.add(actual);
			} else if (pinned !== actual) {
				mismatched.push({ user, pinned, actual });
			}
			continue;
		}
		if (pinned !== undefined) {
			create.push({ user, uid: pinned });
			continue;
		}
		while (used.has(next) || uidTaken(next)) next++;
		if (next > LAST_AGENT_UID) {
			throw new Error(
				`No agent uid left for ${user}: the range ${FIRST_AGENT_UID}-${LAST_AGENT_UID} is used up`,
			);
		}
		map[user] = next;
		used.add(next);
		create.push({ user, uid: next });
		next++;
	}
	return { map, create, mismatched };
}

/** The stored map, or an empty one when the volume has none yet. */
export function readUidMap(agentWorkdir: string): UidMap {
	const path = join(agentWorkdir, UID_MAP_FILE);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw e;
	}
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${path} is not a JSON object of user → uid`);
	}
	const map: UidMap = {};
	for (const [user, uid] of Object.entries(parsed)) {
		if (
			!/^[a-z][a-z0-9-]{0,31}$/.test(user) ||
			!Number.isInteger(uid) ||
			(uid as number) < FIRST_AGENT_UID
		) {
			throw new Error(
				`${path}: invalid entry ${JSON.stringify(user)}: ${JSON.stringify(uid)}`,
			);
		}
		map[user] = uid as number;
	}
	return map;
}

/** Atomic and durable: a crash leaves the old map or the new one. */
export function writeUidMap(agentWorkdir: string, map: UidMap): void {
	const path = join(agentWorkdir, UID_MAP_FILE);
	const tmp = `${path}.tmp`;
	const fd = openSync(
		tmp,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_TRUNC |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeSync(fd, `${JSON.stringify(map, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}
