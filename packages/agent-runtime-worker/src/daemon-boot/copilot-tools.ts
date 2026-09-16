import { createMissionCopilotTools } from "../mission-copilot-tools.js";
import type { BootContext } from "./context.js";

/**
 * Mission copilot elevated tools (ADR-0016). Built once (not per-dispatch)
 * since everything it closes over — db, mailboxRepo, sharedDir, the
 * monitor's own port/token, and the team roster — is stable for the
 * lifetime of this process; config changes only take effect on next
 * resume, so the roster snapshot here is correct for the whole run.
 *
 * Security invariant, carried forward verbatim: the caller's
 * getAdditionalTools must key this off the literal agent id
 * "mission-copilot" — never off anything from teamConfig — so a
 * compromised copilot cannot escalate a different agent to elevated
 * status via SaveMissionConfig (Phase 3). This function only builds the
 * tool list; the keying happens at the runOrchestrationLoop call site.
 *
 * cancelBackgroundJob stays defined in daemon.ts (exported, and already
 * has its own direct unit test coverage in mission-copilot-tools.unit.test.ts)
 * and is passed in as a parameter rather than imported, since nothing
 * outside daemon.ts needs it.
 */
export function buildMissionCopilotTools(
	ctx: Pick<
		BootContext,
		| "db"
		| "missionId"
		| "sharedDir"
		| "objectivesRepo"
		| "mailboxRepo"
		| "monitorPort"
	>,
	missionCopilotEnabled: boolean,
	cancelBackgroundJob: (jobId: string) => boolean,
): Pick<BootContext, "missionCopilotTools"> {
	const missionCopilotTools = missionCopilotEnabled
		? createMissionCopilotTools({
				db: ctx.db,
				missionId: ctx.missionId,
				sharedDir: ctx.sharedDir,
				objectivesRepo: ctx.objectivesRepo,
				mailboxRepo: ctx.mailboxRepo,
				monitorPort: ctx.monitorPort,
				monitorToken: process.env.MONITOR_TOKEN ?? "",
				cancelBackgroundJob,
				controlPlaneUrl: process.env.CONTROL_PLANE_URL ?? "",
			})
		: undefined;
	return { missionCopilotTools };
}
