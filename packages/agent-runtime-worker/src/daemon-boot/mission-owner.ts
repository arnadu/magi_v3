import { createMongoAnomalyRecorder } from "../anomaly.js";
import { createMongoMailboxRepository } from "../mailbox.js";
import { MISSION_COPILOT_AGENT_ID } from "../mission-copilot.js";
import type { BootContext } from "./context.js";

/**
 * Look up the mission's owning user (for relaying hard-severity anomalies to
 * their control-plane copilot mailbox, copilot-{userId}) and construct the
 * anomaly recorder. Reads the mission's own userId directly — replaces a
 * dead COPILOT_MISSION_ID env var that was never set on execution-plane
 * machines and, even set, would have routed every mission's alerts into one
 * global "copilot" mailbox shared across all users (a leftover from before
 * the Sprint 23 multi-user pivot to per-user copilot-{uid}).
 */
export async function constructAnomalyRecorder(
	ctx: Pick<BootContext, "db" | "missionId" | "teamConfig" | "mailboxRepo">,
	missionCopilotEnabled: boolean,
): Promise<Pick<BootContext, "anomalyRecorder">> {
	const missionUserId = (
		await ctx.db
			.collection("missions")
			.findOne({ missionId: ctx.missionId }, { projection: { userId: 1 } })
	)?.userId as string | undefined;
	if (!missionUserId) {
		console.warn(
			`[daemon] Mission ${ctx.missionId} has no userId on its mission document — hard anomalies will not be relayed to a control-plane copilot.`,
		);
	}

	const missionCopilotAgentIdForAnomalies =
		missionCopilotEnabled &&
		ctx.teamConfig.agents.some((a) => a.id === MISSION_COPILOT_AGENT_ID)
			? MISSION_COPILOT_AGENT_ID
			: undefined;
	const anomalyRecorder = createMongoAnomalyRecorder(
		ctx.db,
		ctx.mailboxRepo,
		missionCopilotAgentIdForAnomalies,
		missionUserId
			? {
					mailboxRepo: createMongoMailboxRepository(
						ctx.db,
						`copilot-${missionUserId}`,
					),
					missionId: `copilot-${missionUserId}`,
				}
			: undefined,
	);

	return { anomalyRecorder };
}
