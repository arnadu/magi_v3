/** The daily resource report's shapes and the formatting helpers its build and render steps share. */

import type { MissionDoc } from "@magi/agent-config";
import type { MachineShape } from "./machine-shapes.js";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export interface MissionReportRow {
	missionId: string;
	status: string;
	llm24hUsd: number;
	llmTotalUsd: number;
	llmCapUsd?: number;
	shape: MachineShape;
	upgraded: boolean;
	runningJobs: number | null;
	upgradedMs24h: number;
	upgradedMsSinceReset: number;
	upgradedCapMs: number;
	activeUpgradeExpiresAt?: Date;
	diskUsedBytes?: number;
	diskTotalBytes?: number;
	diskSampleAt?: Date;
	lastActivityAt?: Date;
}

export interface AtlasReportBlock {
	usedBytes: number;
	limitBytes: number;
	databases: Array<{ name: string; bytes: number }>;
	collections: Array<{ name: string; bytes: number }>;
	growthBytesPerDay?: number;
	daysToFull?: number;
}

export interface ReportFlag {
	/** A missionId, or "platform" for a cross-mission/Atlas flag. */
	scope: string;
	label: string;
	detail: string;
}

export interface DailyReport {
	userId: string;
	date: string;
	generatedAt: Date;
	missions: MissionReportRow[];
	atlas?: AtlasReportBlock;
	flags: ReportFlag[];
}

export type MissionDocForReport = Pick<
	MissionDoc,
	"missionId" | "status" | "mission" | "upgrade" | "upgradedRuntimeResetAt"
>;

export interface SnapshotMissionEntry {
	diskUsedBytes?: number;
	llmTotalUsd: number;
	upgradedMs: number;
}

export interface ResourceSnapshotDoc {
	userId: string;
	date: string;
	generatedAt: Date;
	missions: Record<string, SnapshotMissionEntry>;
	atlasBytes?: number;
}

export const dateKey = (d: Date): string => d.toISOString().slice(0, 10);
export const mb = (bytes: number): string => (bytes / 1024 ** 2).toFixed(1);
export const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);
export const hours = (ms: number): string => (ms / HOUR).toFixed(1);

export function formatShape(s: MachineShape): string {
	const gib = s.memoryMb / 1024;
	return `${s.cpuKind} ${s.cpus} CPU / ${Number.isInteger(gib) ? gib : gib.toFixed(1)} GB`;
}

export function minutesAgo(from: Date, to: Date): string {
	const min = Math.round((to.getTime() - from.getTime()) / 60_000);
	if (min < 60) return `${min} min ago`;
	if (min < 24 * 60) return `${(min / 60).toFixed(1)} h ago`;
	return `${Math.round(min / (24 * 60))} d ago`;
}
