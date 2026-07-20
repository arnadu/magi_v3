import { isMap, isSeq, parseDocument } from "yaml";
import type { Limits } from "./loader.js";

/**
 * Surgical edits to a team config's raw YAML, used by the cockpit's Limits
 * panel to change one agent's (or the mission's) limits without a full
 * teamConfigYaml round-trip through the caller. Uses yaml's `Document` API
 * (not `parse()`, used everywhere else in this codebase) specifically
 * because it patches a single node in place and re-serializes the rest of
 * the file — including any hand-written comments — untouched. `parse()`
 * only gives a plain object; rebuilding the whole YAML from that would lose
 * comments and reorder keys.
 *
 * Callers MUST re-validate the result with `parseTeamConfig()` before
 * persisting — these functions only edit the document tree, they don't
 * validate the shape of what they wrote.
 */

// Reserved id for the daemon-injected mission copilot (see ADR-0016). Not
// imported from agent-runtime-worker's mission-copilot.ts — agent-config is
// a lower-level package agent-runtime-worker depends on, not the reverse.
// Matches the same hardcoded-literal precedent already used for this exact
// string in loader.ts's own reserved-id check.
const MISSION_COPILOT_AGENT_ID = "mission-copilot";

/**
 * Set or clear one agent's `limits` block. When `agentId` is the reserved
 * mission-copilot id, patches the top-level `missionCopilotLimits` field
 * instead of `agents[]` — the copilot is daemon-injected and never appears
 * in the authored agents list, but its limits still live in this same
 * document, in this dedicated field, not a separate store.
 *
 * `limits: null` removes the block entirely (falls back to built-in soft
 * defaults, no hard limits) rather than leaving `limits: {}`.
 *
 * Throws if `agentId` doesn't match any authored agent (and isn't the
 * mission-copilot id) — callers should map this to a 404.
 */
export function patchAgentLimits(
	yamlContent: string,
	agentId: string,
	limits: Limits | null,
): string {
	const doc = parseDocument(yamlContent);

	if (agentId === MISSION_COPILOT_AGENT_ID) {
		if (limits === null) {
			doc.delete("missionCopilotLimits");
		} else {
			doc.set("missionCopilotLimits", limits);
		}
		return doc.toString();
	}

	const agents = doc.get("agents");
	if (!isSeq(agents)) {
		throw new Error("Team config has no agents list");
	}
	const target = agents.items.find(
		(item) => isMap(item) && item.get("id") === agentId,
	);
	if (!target || !isMap(target)) {
		throw new Error(`Agent "${agentId}" not found in team config`);
	}
	if (limits === null) {
		target.delete("limits");
	} else {
		target.set("limits", limits);
	}
	return doc.toString();
}

/**
 * Set or clear the mission-wide spend cap (`mission.maxCostUsd`) — the hard
 * cap that pauses the entire mission, distinct from any agent's own
 * `limits.maxLifetimeCostUsd`.
 */
export function patchMissionCap(
	yamlContent: string,
	maxCostUsd: number | null,
): string {
	const doc = parseDocument(yamlContent);
	const mission = doc.get("mission");
	if (!isMap(mission)) {
		throw new Error("Team config has no mission block");
	}
	if (maxCostUsd === null) {
		mission.delete("maxCostUsd");
	} else {
		mission.set("maxCostUsd", maxCostUsd);
	}
	return doc.toString();
}
