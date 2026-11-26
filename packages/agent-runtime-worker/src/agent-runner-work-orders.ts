/**
 * The environment the work-order rules (objectives/work-order.ts, ADR-0038)
 * run in for one agent's turn: the operator-controlled skill tiers, each team
 * agent's disabled skills, where a check script may live, and a shell running
 * as this agent for the check itself.
 */

import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "@magi/agent-config";
import type { WorkOrderEnv } from "./objectives/work-order.js";
import { resolveInside } from "./safe-path.js";
import { discoverSkills } from "./skills.js";
import { type AclPolicy, createBashTool } from "./tools.js";

/** Team and platform skills, name → SKILL.md path (agent-authored tiers excluded). */
export function operatorSkills(sharedDir: string): Map<string, string> {
	const block = discoverSkills(sharedDir, join(sharedDir, ".no-agent-tier"), {
		includeAgentAuthored: false,
	});
	return new Map(block.skills.map((s) => [s.name, s.path]));
}

/**
 * `<skill>/<path>` resolved to a regular file inside the read-only team or
 * platform tier (team first, as skill discovery), symlinks included, or an error.
 */
export function resolveCheckScript(
	sharedDir: string,
	script: string,
): { path: string } | { error: string } {
	const slash = script.indexOf("/");
	const skill = script.slice(0, slash);
	const rest = script.slice(slash + 1);
	for (const tier of ["_team", "_platform"]) {
		const root = join(sharedDir, "skills", tier, skill);
		let path: string;
		try {
			path = resolveInside(root, rest, { mustExist: true });
		} catch {
			continue;
		}
		try {
			if (lstatSync(path).isFile()) return { path };
		} catch {
			// Vanished between the checks: try the next tier.
		}
	}
	return {
		error: `check script "${script}" is not a file inside a team or platform skill`,
	};
}

export function workOrderEnv(
	agents: readonly AgentConfig[],
	workdir: string,
	sharedDir: string,
	acl: AclPolicy,
): WorkOrderEnv {
	const bash = createBashTool(workdir, acl);
	return {
		operatorSkills: () => operatorSkills(sharedDir),
		disabledSkillsFor: (id) => {
			const a = agents.find((x) => x.id === id);
			return a ? (a.disabledSkills ?? []) : null;
		},
		resolveCheckScript: (script) => resolveCheckScript(sharedDir, script),
		runAsCaller: async (command, timeoutSec, signal) => {
			const r = await bash.execute(
				`work-order-check-${Date.now()}`,
				{ command, timeout: timeoutSec },
				signal,
			);
			return {
				ok: !r.isError,
				output: r.content.map((c) => c.text).join(""),
			};
		},
	};
}
