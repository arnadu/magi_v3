/**
 * The mental maps an editor actually changed, compared with what it loaded.
 * Saving only these keeps an untouched map from overwriting what the agent
 * wrote after the editor was opened, and keeps the agent from being told its
 * map was edited when it was not.
 */
export function changedMentalMaps(
	drafts: Record<string, string>,
	loaded: Record<string, string>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(drafts).filter(
			([agentId, html]) => loaded[agentId] !== html,
		),
	);
}
