import type { ActorId } from "./actors.js";
import type { ComponentId } from "./components.js";
import { MISSION_OPERATIONS } from "./operations-missions.js";
import { PLATFORM_OPERATIONS } from "./operations-platform.js";
import { TEAM_OPERATIONS } from "./operations-team.js";
import type { Operation } from "./types.js";

export type OperationId =
	| (typeof MISSION_OPERATIONS)[number]["id"]
	| (typeof TEAM_OPERATIONS)[number]["id"]
	| (typeof PLATFORM_OPERATIONS)[number]["id"];

/**
 * What actors can ask MAGI to do. One operation per intent whose rules
 * differ (who may ask, what is checked, what it costs, what it changes):
 * requests with the same rules are one operation whatever their entry point.
 * Each operation has one implementation (its home); every entry point serving
 * it calls that home and adds only who may ask and how the result is shown.
 */
export const OPERATIONS: readonly Operation<
	OperationId,
	ActorId,
	ComponentId
>[] = [...MISSION_OPERATIONS, ...TEAM_OPERATIONS, ...PLATFORM_OPERATIONS];
