/**
 * Per-mission disk usage sampling (ADR-0032 Decision 2, closes G-4).
 *
 * Runs from the existing 60 s job-runner tick, next to `logMemoryUsage` —
 * no second interval. `AGENT_WORKDIR` is the Fly Volume mount in production
 * (`fly-machines.ts`'s `mounts: [{path: "/missions"}]`); in local dev it's
 * an ordinary directory on the host disk, so disk *alerts* are skipped there
 * (there is no `FLY_APP_NAME`) even though the sample itself is still taken
 * and stored, since a stored-but-unalarmed sample is harmless and keeps the
 * code path exercised in dev.
 *
 * A sampling failure never breaks the tick — every step here is wrapped and
 * logged, never thrown, matching the daemon's existing fail-open posture for
 * stats writes.
 */

import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import type { Db } from "mongodb";
import type { AnomalyRecorder } from "./anomaly.js";
import {
	type AlertStateStore,
	createMongoAlertStateStore,
	evaluateAlert,
} from "./resource-alert-state.js";
import { DISK_USAGE } from "./resource-thresholds.js";

export interface DirectoryUsage {
	path: string;
	kb: number;
}

export interface DiskSample {
	diskUsedBytes: number;
	diskTotalBytes: number;
}

export interface ResourceSamplerDeps {
	db: Db;
	anomalyRecorder: AnomalyRecorder;
	missionId: string;
	/** The Fly Volume mount root in production (`AGENT_WORKDIR`). */
	workdir: string;
	/** `process.memoryUsage().rss`, already sampled once per tick by `logMemoryUsage`. */
	rssMb: number;
	/** The job-runner's own in-flight-job counter, for ADR-0032's `upgrade-idle` check (read back by the control plane's own tick — this daemon never alerts on it itself). */
	runningJobs: number;
	/** True when running on a real Fly Volume; false in local dev (no `FLY_APP_NAME`). */
	alertsEnabled: boolean;
	/** Injected for tests; defaults to `node:fs/promises`'s `statfs`. */
	statfsFn?: typeof statfs;
	/** Injected for tests; defaults to a real, bounded `du` call. */
	duFn?: (workdir: string) => Promise<string>;
	/** Injected for tests; defaults to a real Mongo-backed store. */
	alertStore?: AlertStateStore;
}

const DU_TIMEOUT_MS = 20_000;
const TOP_DIRECTORIES = 5;

async function realDu(workdir: string): Promise<string> {
	return new Promise((resolve) => {
		// -x: stay on one filesystem (the volume); --max-depth=3: bounded scan;
		// no shell, fixed arguments — the workdir is not agent-influenced.
		execFile(
			"du",
			["-x", "-k", "--max-depth=3", workdir],
			{ timeout: DU_TIMEOUT_MS },
			(_err, stdout) => {
				// A timeout or a permission error on some subdirectory still
				// leaves usable partial stdout; only stderr lines are lost, which
				// is fine — this is a best-effort breakdown, not an audit.
				resolve(stdout ?? "");
			},
		);
	});
}

/** Parses `du -k` output (`SIZE_KB\tPATH` per line) into the largest directories, deepest-first ties broken by size. */
export function parseTopDirectories(
	duOutput: string,
	limit = TOP_DIRECTORIES,
): DirectoryUsage[] {
	const rows: DirectoryUsage[] = [];
	for (const line of duOutput.split("\n")) {
		const match = line.match(/^(\d+)\s+(.+)$/);
		if (!match) continue; // skips blank lines and anything malformed
		rows.push({ kb: Number(match[1]), path: match[2] });
	}
	return rows.sort((a, b) => b.kb - a.kb).slice(0, limit);
}

async function readDiskSample(
	workdir: string,
	statfsFn: typeof statfs,
): Promise<DiskSample | null> {
	try {
		const stat = await statfsFn(workdir);
		const diskTotalBytes = stat.blocks * stat.bsize;
		const diskFreeBytes = stat.bavail * stat.bsize;
		return { diskUsedBytes: diskTotalBytes - diskFreeBytes, diskTotalBytes };
	} catch (e) {
		console.error(
			`[resource-sampler] statfs failed { workdir: "${workdir}", error: "${(e as Error).message}" }`,
		);
		return null;
	}
}

function formatDirectories(dirs: DirectoryUsage[]): string {
	return dirs
		.map((d) => `${(d.kb / (1024 * 1024)).toFixed(2)} GB ${d.path}`)
		.join("\n");
}

/**
 * Sample this mission's disk usage once, upsert `missionResources`, and
 * raise `disk-usage-high` through the existing alert de-duplication when
 * over threshold. Called from the 60 s job-runner tick.
 */
export async function sampleDiskUsage(
	deps: ResourceSamplerDeps,
): Promise<void> {
	const { db, missionId, workdir, alertsEnabled, rssMb, runningJobs } = deps;
	const statfsFn = deps.statfsFn ?? statfs;
	const duFn = deps.duFn ?? realDu;
	const alertStore = deps.alertStore ?? createMongoAlertStateStore(db);

	const sample = await readDiskSample(workdir, statfsFn);
	if (!sample) return;

	try {
		await db.collection("missionResources").updateOne(
			{ missionId },
			{
				$set: {
					missionId,
					diskUsedBytes: sample.diskUsedBytes,
					diskTotalBytes: sample.diskTotalBytes,
					rssMb,
					runningJobs,
					updatedAt: new Date(),
				},
			},
			{ upsert: true },
		);
	} catch (e) {
		console.error(
			`[resource-sampler] Failed to store disk sample { missionId: "${missionId}", error: "${(e as Error).message}" }`,
		);
	}

	if (!alertsEnabled || sample.diskTotalBytes === 0) return;

	const ratio = sample.diskUsedBytes / sample.diskTotalBytes;
	let level: "soft" | "hard" | null;
	try {
		level = await evaluateAlert(
			alertStore,
			`${missionId}:disk-usage-high`,
			ratio,
			DISK_USAGE,
		);
	} catch (e) {
		console.error(
			`[resource-sampler] Alert evaluation failed { missionId: "${missionId}", error: "${(e as Error).message}" }`,
		);
		return;
	}
	if (level === null) return;

	let breakdown = "";
	try {
		breakdown = formatDirectories(parseTopDirectories(await duFn(workdir)));
	} catch (e) {
		console.error(
			`[resource-sampler] du failed, alerting without a breakdown { missionId: "${missionId}", error: "${(e as Error).message}" }`,
		);
	}

	const pct = Math.round(ratio * 100);
	const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
	const message = `Mission volume is at ${pct}% (${gb(sample.diskUsedBytes)} / ${gb(sample.diskTotalBytes)} GB).${breakdown ? `\n\nLargest directories:\n${breakdown}` : ""}`;

	await deps.anomalyRecorder
		.record({
			missionId,
			category: "disk-usage-high",
			severity: level,
			message,
		})
		.catch((e) =>
			console.error(
				`[resource-sampler] Failed to record anomaly { missionId: "${missionId}", error: "${(e as Error).message}" }`,
			),
		);
}
