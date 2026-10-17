/**
 * The Tier A tools every mission agent can be given — the names an operator
 * may switch off with `agent.disabledTools`. Kept beside the factories the
 * agent runner calls (agent-runner.ts) and checked against them by
 * tool-catalog.unit.test.ts, so the cockpit's toggle list (served by the
 * control plane's GET /api/catalog) cannot drift from what agents really get.
 *
 * SearchWeb and BrowseWeb are conditional (an API key, a browser); they are
 * listed because a mission may have them.
 */
export const TIER_A_TOOL_NAMES = [
	"Bash",
	"WriteFile",
	"EditFile",
	"PostMessage",
	"ListMessages",
	"ReadMessage",
	"ListTeam",
	"mental_map_update",
	"mental_map_add",
	"mental_map_remove",
	"FetchUrl",
	"InspectImage",
	"Research",
	"AnalyzeMemories",
	"SearchWeb",
	"BrowseWeb",
	"AddTask",
	"UpdateTask",
	"RecordKpi",
	"Allocate",
] as const;

/** Tools present only when their dependency is configured. */
export const CONDITIONAL_TOOL_NAMES: ReadonlySet<string> = new Set([
	"SearchWeb",
	"BrowseWeb",
]);
