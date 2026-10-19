/**
 * `missions`: one document per mission, owned by the control plane. The
 * structured config (`mission`, `agents`, `missionCopilotLimits`, ADR-0021) is
 * the live source of truth the daemon reads at boot; the execution plane may
 * edit those fields only. Everything else — status, machine and volume ids,
 * the spend-cap ceiling, upgrade state — is written by the control plane.
 */

import type { AgentConfig, Limits, TeamConfig } from "../loader.js";

export type MissionStatus =
	| "draft"
	| "provisioning"
	| "running"
	| "suspended"
	| "destroyed"
	| "error";

/** Fly machine CPU class; the control plane's machine shapes use these. */
export type CpuKind = "shared" | "performance";

/** A temporary larger machine (ADR-0031), present while the mission runs on it. */
export interface MissionUpgradeState {
	cpuKind: CpuKind;
	cpus: number;
	memoryMb: number;
	expiresAt: Date;
	requestedByAgentId?: string;
	/** `scheduled_messages` _id (hex) of the renewal reminder. */
	reminderId?: string;
}

export interface MissionDoc {
	missionId: string;
	/** Firebase UID of the owner, or "admin" for CONTROL_API_KEY-created missions. */
	userId: string;
	name: string;
	teamConfig: string;
	/** Structured config (ADR-0021) — the live source of truth. */
	mission?: TeamConfig["mission"];
	agents?: AgentConfig[];
	missionCopilotLimits?: Limits;
	/**
	 * Operator-only spend-cap ceiling (F-025, ADR-0034). A top-level field,
	 * never part of `mission`/`agents`/`missionCopilotLimits`, so no
	 * execution-plane tool can read or write it. Absent means no ceiling.
	 */
	maxCostCeilingUsd?: number;
	/** Team files (skills, etc.) stored at provision time; updated on config edit. */
	teamFiles?: Array<{ path: string; content: string }>;
	machineId?: string;
	privateIp?: string;
	volumeId?: string;
	status: MissionStatus;
	/** Set when status === "error"; cleared on successful resume. */
	errorMessage?: string;
	/** Set while a machine resize (ADR-0031) is in flight. */
	resize?: { claimedAt?: Date; lastAt?: Date };
	upgrade?: MissionUpgradeState;
	/**
	 * Operator-only reset point for the cumulative upgraded-runtime cap
	 * (ADR-0031 Decision 7); never written by an execution-plane path.
	 */
	upgradedRuntimeResetAt?: Date;
	createdAt: Date;
	updatedAt: Date;
}
