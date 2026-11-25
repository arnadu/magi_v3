/**
 * `missionAnomalies`: problems recorded against a mission (crashes, timeouts,
 * limit breaches, resource alerts). Written by the worker's AnomalyRecorder
 * and the control plane's resource checks; read by the daily resource report
 * and relayed to the copilots.
 */

export type AnomalyCategory =
	| "limit-breach"
	| "agent-crash"
	| "agent-timeout"
	| "llm-error"
	| "job-failure"
	| "scheduling-failure"
	| "unclean-restart"
	| "reflection-failed"
	// Resource oversight (ADR-0031/0032). The platform-level Atlas storage alert
	// has no mission and is posted straight to the admin copilots' mailboxes
	// instead of going through this recorder.
	| "disk-usage-high"
	| "spend-cap-near"
	| "uncapped-spend"
	| "spend-spike"
	| "upgrade-cap-near"
	| "upgrade-cap-reached"
	| "upgrade-idle"
	| "resize-failure"
	| "oom-suspected"
	// Control-plane mission lifecycle. Distinct from resize-failure (ADR-0031's
	// upgrade/revert path): this covers a plain operator/copilot-initiated
	// resume failing, for any reason (e.g. a drifted `volumeId` — see issue #62).
	| "resume-failure"
	// A machine could not be placed on its volume's full server, so the volume
	// was forked to another zone and the mission moved to the fork (#103).
	| "volume-forked"
	// The machine firewall (`magi-net init`) could not be set at boot
	// (ADR-0037): inbound private-network traffic is unfiltered, apps disabled.
	| "firewall-failure"
	// An agent got the same error from one tool several times in a row
	// (repeated-tool-failure.ts): likely misreading the error.
	| "tool-repeated-failure"
	// A running mission's machine is stopped after an exit nobody requested,
	// Fly's restarts used up (fly-events.ts): the daemon is not coming back.
	| "machine-down"
	// A platform task (mission.platform-task) failed several runs in a row, or could not run
	// at all (platform-tasks.ts): its output is stale or missing.
	| "platform-task-failure";

export type AnomalySeverity = "hard" | "soft";

export interface MissionAnomaly {
	missionId: string;
	category: AnomalyCategory;
	severity: AnomalySeverity;
	agentId?: string;
	turnNumber?: number;
	message: string;
	createdAt: Date;
}
