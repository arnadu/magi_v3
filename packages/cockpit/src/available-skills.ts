/** Skills an agent can toggle: the platform's, plus any the mission ships as `skills/<name>/SKILL.md` team files. */
export function availableSkills(
	platformSkills: string[],
	teamFiles: Array<{ path: string }>,
): string[] {
	const team = teamFiles
		.map((f) => {
			const m = f.path.match(/^skills\/([^/]+)\/SKILL\.md$/);
			return m ? m[1] : null;
		})
		.filter((s): s is string => s !== null);
	return [...new Set([...platformSkills, ...team])];
}
