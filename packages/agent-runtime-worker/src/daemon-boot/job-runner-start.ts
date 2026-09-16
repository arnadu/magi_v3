import type { TeamConfig } from "@magi/agent-config";
import { recoverOrphanedJobs } from "../job-recovery.js";
import type { MailboxRepository } from "../mailbox.js";
import type { ToolApiServer } from "../tool-api-server.js";
import type { BootContext } from "./context.js";

/**
 * F-010: recover jobs left in jobs/running/ by a prior daemon run (they have
 * no live token, so their magi-tool calls would fail with 401 — moving them
 * back to pending/ lets the next heartbeat retry them, or fail them out
 * permanently past the crash-count threshold, see recoverOrphanedJobs' own
 * doc comment), then start the job-runner heartbeat.
 *
 * startJobRunner itself stays defined in daemon.ts (along with
 * runPendingJobs and logMemoryUsage, which it wraps) — passed in here as a
 * parameter rather than imported, since nothing outside daemon.ts needs it
 * and importing it back from a daemon-boot module would be circular for no
 * benefit.
 */
export async function startBackgroundJobs(
	ctx: Pick<
		BootContext,
		| "sharedDir"
		| "workdir"
		| "missionId"
		| "mailboxRepo"
		| "anomalyRecorder"
		| "toolApiServer"
		| "toolPort"
		| "teamConfig"
	>,
	startJobRunner: (
		sharedDir: string,
		workdir: string,
		missionId: string,
		toolApiServer: ToolApiServer,
		toolPort: number,
		mailboxRepo: MailboxRepository,
		teamConfig: TeamConfig,
	) => () => void,
): Promise<Pick<BootContext, "stopJobRunner">> {
	await recoverOrphanedJobs(
		ctx.sharedDir,
		ctx.missionId,
		ctx.mailboxRepo,
		ctx.anomalyRecorder,
	);
	const stopJobRunner = startJobRunner(
		ctx.sharedDir,
		ctx.workdir,
		ctx.missionId,
		ctx.toolApiServer,
		ctx.toolPort,
		ctx.mailboxRepo,
		ctx.teamConfig,
	);
	return { stopJobRunner };
}
