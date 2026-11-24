/**
 * The tenant rule, in one place: a caller reaches only the missions it owns, an admin reaches
 * all. Every lookup of a mission on a caller's behalf spreads this into its filter: the
 * mission routes (through mission-scope.ts's userFilter), the proxy to mission machines and
 * the apps' open path. Lives with authentication because it is about who the caller is.
 */
export function ownerFilter(caller: { isAdmin?: boolean; userId?: string }): {
	userId?: string;
} {
	return caller.isAdmin ? {} : { userId: caller.userId };
}
