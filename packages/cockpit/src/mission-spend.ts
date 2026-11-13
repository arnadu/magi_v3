import type { FoldedTree } from "./types";

/**
 * The header's spend figure: the mission's real spend against its spend cap,
 * as the Limits panel shows it. Summing objective costs instead under-reports
 * whatever an agent has spent but not yet attributed to a task, and summing
 * objective budgets showed "/ $0.00" for a mission whose objectives have none.
 * Falls back to the objectives sum for a server that does not send `spend`.
 */
export function headerSpend(tree: FoldedTree): {
	spentUsd: number;
	capUsd: number | null;
} {
	if (tree.spend) {
		return { spentUsd: tree.spend.totalUsd, capUsd: tree.spend.capUsd };
	}
	return {
		spentUsd: tree.objectives.reduce((a, o) => a + o.costUsd, 0),
		capUsd: null,
	};
}

/** Spend not yet attributed to any task or objective, when worth showing (half a cent or more). */
export function unattributedUsd(tree: FoldedTree): number | null {
	const u = tree.spend?.unattributedUsd ?? 0;
	return u >= 0.005 ? u : null;
}
