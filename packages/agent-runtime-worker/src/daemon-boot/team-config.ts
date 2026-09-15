import { basename, dirname, join } from "node:path";
import { loadTeamConfig, parseTeamConfig } from "@magi/agent-config";
import type { BootContext } from "./context.js";

export type LoadTeamConfigResult =
	| ({ ok: true } & Pick<BootContext, "teamConfig" | "missionId" | "teamDir">)
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
		const missionDoc = await ctx.db
			.collection("missions")
			.findOne({ missionId });
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
		return { ok: true, teamConfig, missionId, teamDir };
	}

	// Standalone local/dev path — boot directly against a hand-authored YAML
	// file, no MongoDB `missions` document required.
	process.stdout.write("[daemon] Loading team config from file…\n");
	// biome-ignore lint/style/noNonNullAssertion: checked by the caller — missionIdEnv is falsy here, so teamConfigPath must be set
	const teamConfig = loadTeamConfig(ctx.teamConfigPath!);
	const missionId = teamConfig.mission.id;
	const teamDir = join(
		// biome-ignore lint/style/noNonNullAssertion: same as above
		dirname(ctx.teamConfigPath!),
		// biome-ignore lint/style/noNonNullAssertion: same as above
		basename(ctx.teamConfigPath!, ".yaml"),
	);
	return { ok: true, teamConfig, missionId, teamDir };
}
