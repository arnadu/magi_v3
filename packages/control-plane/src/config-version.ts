/**
 * Optimistic concurrency for the full-replace config PUT: the editor sends
 * the `updatedAt` it loaded; a save against a document that has moved since
 * (another tab, the copilot's `save_session_config`) is refused instead of
 * silently overwriting agents, mental maps and team files.
 */
export function configChangedSince(
	currentUpdatedAt: Date | string | undefined,
	expectedUpdatedAt: string | undefined,
): string | null {
	if (expectedUpdatedAt === undefined || !currentUpdatedAt) return null;
	const expected = new Date(expectedUpdatedAt).getTime();
	if (Number.isNaN(expected)) return "expectedUpdatedAt is not a date";
	if (new Date(currentUpdatedAt).getTime() === expected) return null;
	return "This mission's config changed since you loaded it — reload the tab and re-apply your edits.";
}
