/**
 * Compile-time checks for stored/paths.ts. Not run, only type-checked
 * (`npm run typecheck`): each @ts-expect-error must fail to compile, so a
 * regression that lets a wrong path through breaks the build.
 */
import { field, ref } from "../src/stored/paths.js";

interface Doc {
	missionId: string;
	at: Date;
	tags: string[];
	usage: { inputTokens: number; cost: { totalCostUsd: number } };
	optional?: { nested: number };
}

const f = field<Doc>();
const r = ref<Doc>();

export const ok: string[] = [
	f("missionId"),
	f("usage.inputTokens"),
	f("usage.cost.totalCostUsd"),
	f("optional.nested"),
	r("usage.cost.totalCostUsd"),
];
export const exact: "$usage.inputTokens" = r("usage.inputTokens");

// @ts-expect-error — no such field
f("usage.total");
// @ts-expect-error — Dates are leaves
f("at.getTime");
// @ts-expect-error — arrays are leaves
f("tags.length");
// @ts-expect-error — stale name from before the cost rename
r("cost.total");
