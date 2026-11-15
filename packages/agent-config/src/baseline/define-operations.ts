import type { ActorId } from "./actors.js";
import type { ComponentId } from "./components.js";
import type { Operation } from "./types.js";

/** Keeps each operation id a literal type, so references to it are checked by `tsc`. */
export function defineOperations<const O extends string>(
	ops: readonly Operation<O, ActorId, ComponentId>[],
): readonly Operation<O, ActorId, ComponentId>[] {
	return ops;
}
