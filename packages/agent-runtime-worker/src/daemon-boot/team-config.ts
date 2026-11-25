import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	loadTeamConfig,
	parseSecurityAlerts,
	parseTeamConfig,
	rawPlatformTasksYaml,
	rawSecurityAlertsYaml,
	storedCollection,
} from "@magi/agent-config";
import type { BootContext } from "./context.js";

export type LoadTeamConfigResult =
	| ({ ok: true } & Pick<
			BootContext,
			| "teamConfig"
			| "missionId"
			| "teamDir"
			| "platformTasksRaw"
			| "securityAlertsAgents"
	  >)
	| { ok: false; exitMessage: string };

/**
 * Load the mission's team config, either from MongoDB (control-plane-
 * provisioned path, ADR-0021 — a missing or invalid document is a hard
 * failure, never a silent default) or from a hand-authored YAML file
 * (standalone local/dev path). The YAML branch's loadTeamConfig() call is
 * deliberately left un-caught here, exactly as in the original inline code:
 * a bad local YAML file propagates as an uncaught rejection to main()'s own
 * top-level .catch(), not through this function's discriminated result —
 * only the MongoDB branch's two failure modes go through { ok: false }.
 */
export async function loadDaemonTeamConfig(
	ctx: Pick<BootContext, "db"> & {
		missionIdEnv: string | undefined;
		teamConfigPath: string | undefined;
		agentWorkdir: string;
	},
): Promise<LoadTeamConfigResult> {
	if (ctx.missionIdEnv) {
		process.stdout.write("[daemon] Loading team config from MongoDB…\n");
		const missionId = ctx.missionIdEnv;
		const missionDoc = await storedCollection(ctx.db, "missions").findOne({
			missionId,
		});
		if (!missionDoc?.mission || !missionDoc.agents) {
			return {
				ok: false,
				exitMessage: `Error: no structured config stored for mission ${missionId}`,
			};
		}
		let teamConfig: BootContext["teamConfig"];
		try {
			teamConfig = parseTeamConfig({
				mission: missionDoc.mission,
				agents: missionDoc.agents,
				missionCopilotLimits: missionDoc.missionCopilotLimits,
			});
		} catch (e) {
			return {
				ok: false,
				exitMessage: `Error: stored config for mission ${missionId} is invalid: ${(e as Error).message}`,
			};
		}
		const teamDir = join(ctx.agentWorkdir, "team");
		return {
			ok: true,
			teamConfig,
			missionId,
			teamDir,
			platformTasksRaw: missionDoc.platformTasks,
			securityAlertsAgents: alertsAgents(missionDoc.securityAlerts),
		};
	}

	// Standalone local/dev path — boot directly against a hand-authored YAML
	// file, no MongoDB `missions` document required.
	process.stdout.write("[daemon] Loading team config from file…\n");
	const configPath = ctx.teamConfigPath;
	if (!configPath) {
		return {
			ok: false,
			exitMessage: "Error: neither MISSION_ID nor TEAM_CONFIG is set",
		};
	}
	const teamConfig = loadTeamConfig(configPath);
	const yaml = readFileSync(configPath, "utf8");
	const missionId = teamConfig.mission.id;
	const teamDir = join(dirname(configPath), basename(configPath, ".yaml"));
	return {
		ok: true,
		teamConfig,
		missionId,
		teamDir,
		platformTasksRaw: rawPlatformTasksYaml(yaml),
		securityAlertsAgents: alertsAgents(rawSecurityAlertsYaml(yaml)),
	};
}

/** The agents allowed to read security alerts; none when the field is absent or invalid (logged). */
function alertsAgents(raw: unknown): readonly string[] {
	try {
		return parseSecurityAlerts(raw)?.agents ?? [];
	} catch (e) {
		console.error(
			`[daemon] the mission's securityAlerts field is invalid, no agent gets SecurityAlerts: ${(e as Error).message}`,
		);
		return [];
	}
}
