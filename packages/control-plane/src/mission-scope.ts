import type { Request } from "express";
import type { Collection, Db } from "mongodb";
import type { MissionDoc } from "./missions.js";

export type { MissionDoc };

/** Admin sees all missions; regular users see only their own. */
export function userFilter(req: Request): Partial<MissionDoc> {
	return req.isAdmin ? {} : { userId: req.userId };
}

/** What every missions route handler is built from. */
export interface MissionRouteDeps {
	db: Db;
	col: Collection<MissionDoc>;
}
