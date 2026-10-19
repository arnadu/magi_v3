/**
 * Typed dotted paths into a stored document, for the places a field name is
 * a string: `$match`/`$set` keys and aggregation expressions. A path that does
 * not exist on the document type fails `tsc` instead of silently matching
 * nothing (how `cost.total` outlived its rename).
 *
 *   const f = field<LlmCallLogEntry>();
 *   col.updateOne({ [f("usage.inputTokens")]: { $gt: 0 } }, …)
 *   const r = ref<LlmCallLogEntry>();
 *   { $sum: r("usage.cost.totalCostUsd") }   // "$usage.cost.totalCostUsd"
 */

/** Values a path stops at: scalars, dates, arrays and BSON values such as ObjectId. */
type Leaf =
	| string
	| number
	| boolean
	| bigint
	| symbol
	| null
	| undefined
	| Date
	| readonly unknown[]
	| { _bsontype: unknown };

type Depth = [never, 0, 1, 2, 3];

/** Every dotted path into T, four levels deep. Distributes over unions. */
export type Path<T, D extends number = 4> = [D] extends [never]
	? never
	: T extends Leaf
		? never
		: {
				[K in keyof T & string]: NonNullable<T[K]> extends Leaf
					? K
					: K | `${K}.${Path<NonNullable<T[K]>, Depth[D]>}`;
			}[keyof T & string];

/** A query or update key on T. */
export function field<T>(): <P extends Path<T>>(path: P) => P {
	return (path) => path;
}

/** An aggregation field reference on T (`$`-prefixed). */
export function ref<T>(): <P extends Path<T>>(path: P) => `$${P}` {
	return (path) => `$${path}` as const;
}
