import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { type JobSpec, readFailedJobStatus } from "./job-recovery.js";
import { enqueuePrivateJob, jobDirs } from "./job-runner.js";
import { MISSION_COPILOT_AGENT_ID } from "./mission-copilot.js";
import type { MissionCopilotToolDeps } from "./mission-copilot-tool-deps.js";
import { err, ok, okJson } from "./mission-copilot-tool-result.js";
import type { MagiTool } from "./tools.js";

// ─── Family E — Direct Intervention ──────────────────────────────────────
function pauseAgentTool(deps: MissionCopilotToolDeps): MagiTool {
	const { monitorPost, auditPost } = deps;
	return {
		name: "PauseAgent",
		description:
			"Halt a teammate at its next dispatch boundary. Rejects targeting yourself. Posts an audit message to the user's mailbox.",
		parameters: Type.Object({
			agentId: Type.String({ description: "Teammate to pause" }),
		}),
		async execute(_id, args) {
			const agentId = args.agentId as string;
			if (agentId === MISSION_COPILOT_AGENT_ID) {
				return err("Cannot pause yourself.");
			}
			const result = await monitorPost("/pause-agent", { agentId });
			if (!result.ok) return err(`Failed to pause ${agentId}: ${result.body}`);
			await auditPost(
				`Paused agent "${agentId}"`,
				`I paused "${agentId}" at its next dispatch boundary.`,
			);
			return ok(result.body);
		},
	};
}

function resumeAgentTool(deps: MissionCopilotToolDeps): MagiTool {
	const { monitorPost, auditPost } = deps;
	return {
		name: "ResumeAgent",
		description:
			"Lift a previous pause. Posts an audit message to the user's mailbox.",
		parameters: Type.Object({
			agentId: Type.String({ description: "Teammate to resume" }),
		}),
		async execute(_id, args) {
			const agentId = args.agentId as string;
			const result = await monitorPost("/resume-agent", { agentId });
			if (!result.ok) return err(`Failed to resume ${agentId}: ${result.body}`);
			await auditPost(
				`Resumed agent "${agentId}"`,
				`I lifted the pause on "${agentId}".`,
			);
			return ok(result.body);
		},
	};
}

function cancelBackgroundJobTool(deps: MissionCopilotToolDeps): MagiTool {
	const { cancelBackgroundJob, auditPost } = deps;
	return {
		name: "CancelBackgroundJob",
		description:
			"Kill a running background job (a run-background-skill job, distinct from the scheduled messages above). Posts an audit message to the user's mailbox.",
		parameters: Type.Object({
			jobId: Type.String({ description: "Job id (from ListBackgroundJobs)" }),
		}),
		async execute(_id, args) {
			const jobId = args.jobId as string;
			const killed = cancelBackgroundJob(jobId);
			if (!killed) {
				return err(
					`Job "${jobId}" is not currently running (already finished, or the id is unknown) — check ListBackgroundJobs.`,
				);
			}
			await auditPost(
				`Cancelled background job "${jobId}"`,
				`I killed running background job ${jobId}.`,
			);
			return okJson({ ok: true });
		},
	};
}

function restartBackgroundJobTool(deps: MissionCopilotToolDeps): MagiTool {
	const { sharedDir, auditPost } = deps;
	return {
		name: "RestartBackgroundJob",
		description:
			"Re-submit a failed or cancelled job's original spec as a new job. Runs under the copilot's own identity in the sense that this call, not the original submitter's turn, is what resubmits it — fine for jobs that write to sharedDir (the common case), but note the distinction if a job was scoped to a specific agent's own workdir. Posts an audit message to the user's mailbox.",
		parameters: Type.Object({
			jobId: Type.String({
				description:
					"The failed/cancelled job's original id (from ListBackgroundJobs)",
			}),
		}),
		async execute(_id, args) {
			const jobId = args.jobId as string;
			const dirs = jobDirs(sharedDir);
			const status = readFailedJobStatus(dirs, jobId);
			if ("error" in status) return err(status.error);
			const original = status.spec;
			const newId = randomUUID();
			const newSpec: JobSpec = {
				id: newId,
				agentId: original.agentId,
				scriptPath: original.scriptPath,
				args: original.args,
				notifyAgentId: original.notifyAgentId,
				notifySubject: original.notifySubject,
				timeoutMs: original.timeoutMs,
			};
			// Daemon-authored: goes to the private queue, never to the agents'
			// pending dir (where a daemon-owned file is refused as unattributable).
			enqueuePrivateJob(dirs, newSpec);
			await auditPost(
				`Restarted background job "${jobId}"`,
				`I resubmitted job ${jobId}'s original spec as a new job (${newId}). It will run on the daemon's next job-runner heartbeat (within 60s).`,
			);
			return okJson({ ok: true, newJobId: newId });
		},
	};
}

export function createInterventionTools(deps: MissionCopilotToolDeps) {
	return {
		pauseAgent: pauseAgentTool(deps),
		resumeAgent: resumeAgentTool(deps),
		cancelBackgroundJobTool: cancelBackgroundJobTool(deps),
		restartBackgroundJob: restartBackgroundJobTool(deps),
	};
}
