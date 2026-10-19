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
	| "resume-failure";

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
