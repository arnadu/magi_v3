import type { Request } from "express";
import type { Collection, Db } from "mongodb";
import { ownerFilter } from "./auth-scope.js";
import type { MissionDoc } from "./missions.js";

export type { MissionDoc };

/** Admin sees all missions; regular users see only their own. */
/** The tenant rule (auth-scope.ts) for a request: the caller's own missions, or all for an admin. */
export function userFilter(req: Request): Partial<MissionDoc> {
	return ownerFilter(req);
}

/** What every missions route handler is built from. */
export interface MissionRouteDeps {
	db: Db;
	col: Collection<MissionDoc>;
}
