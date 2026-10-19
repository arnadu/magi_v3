/**
 * What every mission-copilot tool family receives: the mission's
 * configuration plus the shared helpers (monitor calls, the config writer,
 * the audit post). missionId is always supplied here, never by the model.
 */

import type { Db } from "mongodb";
import type { MailboxRepository } from "./mailbox.js";
import { createMongoMissionConfigWriter } from "./mission-config-revisions.js";
import { MISSION_COPILOT_AGENT_ID } from "./mission-copilot.js";
import { err } from "./mission-copilot-tool-result.js";
import type { ObjectivesRepository } from "./objectives/repository.js";
import type { ToolResult } from "./tools.js";

export interface MissionCopilotToolsConfig {
	db: Db;
	missionId: string;
	sharedDir: string;
	objectivesRepo: ObjectivesRepository;
	mailboxRepo: MailboxRepository;
	monitorPort: number;
	/** Empty string in local dev, matching MonitorServer's own fail-open convention for that case. */
	monitorToken: string;
	/**
	 * Kill a running background job's process group. Reaches daemon.ts's
	 * module-level job registry directly (same process, no HTTP needed) —
	 * see daemon.ts's runningJobProcesses for why this couldn't exist before
	 * ADR-0016 (no registry mapped a running job's PID to anything reachable
	 * outside runPendingJobs's own closure).
	 */
	cancelBackgroundJob: (jobId: string) => boolean;
	/**
	 * Base URL of the control plane's GitHub proxy (Phase 5) — empty string
	 * in local dev, where the proxy isn't reachable. Family G tools degrade
	 * to a clear error rather than throwing when absent.
	 */
	controlPlaneUrl: string;
}

export interface MissionCopilotToolDeps extends MissionCopilotToolsConfig {
	missionConfigWriter: ReturnType<typeof createMongoMissionConfigWriter>;
	monitorGet(path: string): Promise<ToolResult>;
	monitorPost(
		path: string,
		payload: unknown,
	): Promise<{ ok: boolean; body: string; status: number }>;
	auditPost(subject: string, body: string): Promise<void>;
}

export function createToolDeps(
	config: MissionCopilotToolsConfig,
): MissionCopilotToolDeps {
	const { db, missionId, mailboxRepo, monitorPort, monitorToken } = config;
	const missionConfigWriter = createMongoMissionConfigWriter(db);

	/**
	 * Returns the RAW response body, deliberately untruncated. Most call sites
	 * JSON.parse() this before re-wrapping through ok()/okJson() (which does
	 * truncate) — truncating here first would cut the JSON mid-structure,
	 * break the parse, and fall through to returning mangled JSON instead of
	 * the clean, properly-processed result. Call sites that pass the body
	 * straight through without further processing are responsible for their
	 * own ok()/truncate() call.
	 */
	async function monitorGet(path: string): Promise<ToolResult> {
		try {
			const res = await fetch(`http://127.0.0.1:${monitorPort}${path}`, {
				headers: { "x-monitor-token": monitorToken },
				signal: AbortSignal.timeout(10_000),
			});
			const body = await res.text();
			if (!res.ok)
				return err(`Monitor ${path} returned ${res.status}: ${body}`);
			return { content: [{ type: "text", text: body }] };
		} catch (e) {
			return err(`Failed to reach monitor server: ${(e as Error).message}`);
		}
	}

	async function monitorPost(
		path: string,
		payload: unknown,
	): Promise<{ ok: boolean; body: string; status: number }> {
		const res = await fetch(`http://127.0.0.1:${monitorPort}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-monitor-token": monitorToken,
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(10_000),
		});
		const body = await res.text();
		return { ok: res.ok, body, status: res.status };
	}

	/** Every mutating tool posts a same-turn audit copy to the user — the only review gate for anything without a resume-delay grace period (F-026). */
	async function auditPost(subject: string, body: string): Promise<void> {
		await mailboxRepo.post({
			missionId,
			from: MISSION_COPILOT_AGENT_ID,
			to: ["user"],
			subject,
			body,
		});
	}

	return {
		...config,
		missionConfigWriter,
		monitorGet,
		monitorPost,
		auditPost,
	};
}
