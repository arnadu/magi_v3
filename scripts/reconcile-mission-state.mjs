#!/usr/bin/env node
/**
 * Reconcile MongoDB mission state against the real state of the Fly.io
 * execution plane (machines + volumes). Read-only by default — prints a
 * report of drift. Two opt-in flags apply narrowly-scoped fixes:
 *
 *   --fix-status     Correct a mission's Mongo `status` field when it
 *                     disagrees with the real Fly machine state (Mongo-only
 *                     write, never touches Fly). Compare-and-set: a mission
 *                     whose status moved between the scan and the fix is
 *                     reported and left alone. Does not resurrect missing
 *                     machines or fix missing machineId/volumeId.
 *   --purge-orphans  Destroy Fly machines/volumes that exist on Fly but are
 *                     referenced by no mission document at all (orphaned).
 *                     DESTRUCTIVE and irreversible. Prints the plan and
 *                     refuses to act unless --yes is also given. Never
 *                     touches: a machine with a volume mount (a mission
 *                     machine whose document is missing or drifted), a
 *                     volume that is attached to a machine, or anything
 *                     younger than --min-age-hours (default 24 — a provision
 *                     may still be in flight). Each skip is printed with its
 *                     reason. Rules: scripts/lib/reconcile-policy.mjs.
 *   --yes            Required with --purge-orphans.
 *   --min-age-hours N  Age gate for --purge-orphans (default 24).
 *
 * Usage:
 *   node scripts/reconcile-mission-state.mjs                    # report only
 *   node scripts/reconcile-mission-state.mjs --fix-status
 *   node scripts/reconcile-mission-state.mjs --purge-orphans          # plan only
 *   node scripts/reconcile-mission-state.mjs --purge-orphans --yes    # destroys
 *
 * Requires MONGODB_URI, FLY_API_TOKEN_MACHINES, FLY_MISSIONS_APP_NAME (env
 * or .env) — the same variables the control plane itself uses. Set
 * FLY_MISSIONS_IMAGE to the control plane's current pin as well, or every
 * running machine on a pinned deployment tag is reported as image drift.
 *
 * What this does NOT do: reconcile local-execution missions against a real
 * running daemon process on a *remote* machine (only checks the local PID
 * file, so it only means something when run on the same host as the local
 * daemon). Does not fix a mission whose machineId/volumeId is simply
 * missing/wrong — that needs a human decision (resume vs. mark destroyed).
 *
 * Report-only mode also flags any mission whose `volumeId` doesn't match a
 * real Fly volume, independent of whether its `machineId` is fine (added
 * 2026-09-24 after a live incident where exactly this happened silently on
 * two missions — one only surfaced once someone tried to resume it, the
 * other was still sitting undetected). Never auto-fixed, even under
 * --fix-status: the correct ID can only be found by a human checking
 * `flyctl volumes list` for the mission's actual volume. The same incident
 * is why --purge-orphans skips attached volumes: the real volume of a
 * drifted mission is exactly what looks orphaned.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
	applyStatusFix,
	classifyOrphans,
	parseMinAgeHours,
} from "./lib/reconcile-policy.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), "..");

// .env if present (dev mode); never overrides variables already in the environment.
loadDotenv({ path: join(REPO_ROOT, ".env"), quiet: true });

const args = process.argv.slice(2);
const fixStatus = args.includes("--fix-status");
const purgeOrphans = args.includes("--purge-orphans");
const confirmed = args.includes("--yes");
let minAgeHours;
try {
	minAgeHours = parseMinAgeHours(args);
} catch (e) {
	console.error(`Error: ${e.message}`);
	process.exit(1);
}

const mongoUri = process.env.MONGODB_URI;
const flyToken = process.env.FLY_API_TOKEN_MACHINES;
const flyApp = process.env.FLY_MISSIONS_APP_NAME;

if (!mongoUri || !flyToken || !flyApp) {
	console.error(
		"Error: MONGODB_URI, FLY_API_TOKEN_MACHINES, and FLY_MISSIONS_APP_NAME are all required.",
	);
	process.exit(1);
}

const FLY_API_BASE = "https://api.machines.dev/v1";

async function flyFetch(path, options = {}) {
	const res = await fetch(`${FLY_API_BASE}${path}`, {
		...options,
		headers: {
			Authorization: `Bearer ${flyToken}`,
			"Content-Type": "application/json",
			...options.headers,
		},
	});
	if (!res.ok) {
		throw new Error(`Fly API ${path} → ${res.status} ${await res.text()}`);
	}
	return res.json();
}

/** Fly machine "started"/"stopped" ↔ MAGI's mission status vocabulary. */
function flyStateToMissionStatus(flyState) {
	if (flyState === "started" || flyState === "starting") return "running";
	if (flyState === "stopped" || flyState === "stopping") return "suspended";
	return null; // no clean mapping (e.g. "destroying") — don't guess
}

async function main() {
	const { MongoClient } = await import("mongodb");
	const client = new MongoClient(mongoUri, { ignoreUndefined: true });
	await client.connect();
	const db = client.db();

	console.log(`Connected to MongoDB (db: ${db.databaseName})`);
	console.log(`Fly app: ${flyApp}`);
	console.log(
		`Mode: ${purgeOrphans ? (confirmed ? "PURGE ORPHANS (destructive)" : "purge-orphans PLAN (no --yes: nothing is destroyed)") : fixStatus ? "fix-status" : "report only"}\n`,
	);

	const missions = db.collection("missions");
	const allMissions = await missions.find({}).toArray();
	const activeMissions = allMissions.filter((m) => m.status !== "destroyed");

	const [{ data: flyMachines }, flyVolumes] = await Promise.all([
		flyFetch(`/apps/${flyApp}/machines`).then((data) => ({ data })),
		flyFetch(`/apps/${flyApp}/volumes`),
	]);

	const machineById = new Map(flyMachines.map((m) => [m.id, m]));
	const volumeIdSet = new Set(flyVolumes.map((v) => v.id));
	const referencedMachineIds = new Set(
		activeMissions.map((m) => m.machineId).filter(Boolean),
	);
	const referencedVolumeIds = new Set(
		activeMissions.map((m) => m.volumeId).filter(Boolean),
	);

	const findings = {
		statusDrift: [],
		missingMachine: [],
		missingVolume: [],
		imageDrift: [],
		staleLocal: [],
	};

	// ── 0. Volume-existence check, independent of machine state (2026-09-24
	// live incident: a mission's `volumeId` in Mongo drifted to an ID that
	// never existed on Fly while its *machineId* still matched a real,
	// healthy machine — this must run regardless of what the machine check
	// below finds, not nested inside it). Never auto-fixed, even under
	// --fix-status: the correct volumeId can only be found by a human
	// checking `flyctl volumes list` for the mission's actual volume. ──
	for (const m of activeMissions) {
		if (!m.volumeId || m.volumeId.startsWith("local-")) continue;
		if (!volumeIdSet.has(m.volumeId)) {
			findings.missingVolume.push({
				missionId: m.missionId,
				volumeId: m.volumeId,
				status: m.status,
			});
		}
	}

	// ── 1. Per-mission checks (Fly-backed) ──────────────────────────────────
	for (const m of activeMissions) {
		if (!m.machineId) continue;
		if (m.machineId.startsWith("local-")) {
			// Local-execution mission — check the local PID file, but only
			// meaningful if this script runs on the same host as the daemon.
			if (m.status === "running") {
				const pidFile = join(
					process.env.AGENT_WORKDIR ?? homedir(),
					"missions",
					m.missionId,
					"daemon.pid",
				);
				const localMissionsDir =
					process.env.LOCAL_MISSIONS_DIR ?? join(homedir(), ".magi", "local");
				const altPidFile = join(
					localMissionsDir,
					m.missionId,
					"..",
					"missions",
					m.missionId,
					"daemon.pid",
				);
				const candidates = [pidFile, altPidFile];
				let alive = false;
				for (const f of candidates) {
					if (!existsSync(f)) continue;
					try {
						const pid = Number.parseInt(readFileSync(f, "utf-8").trim(), 10);
						process.kill(pid, 0); // throws if not alive
						alive = true;
					} catch {
						/* not alive via this candidate */
					}
				}
				if (!alive) {
					findings.staleLocal.push({
						missionId: m.missionId,
						status: m.status,
						reason:
							"marked running but no live local daemon PID found (checked on this host only)",
					});
				}
			}
			continue;
		}

		const machine = machineById.get(m.machineId);
		if (!machine) {
			findings.missingMachine.push({
				missionId: m.missionId,
				machineId: m.machineId,
				status: m.status,
			});
			continue;
		}

		const realStatus = flyStateToMissionStatus(machine.state);
		if (
			realStatus &&
			realStatus !== m.status &&
			m.status !== "provisioning" &&
			m.status !== "error"
		) {
			findings.statusDrift.push({
				missionId: m.missionId,
				mongoStatus: m.status,
				flyState: machine.state,
				impliedStatus: realStatus,
			});
		}

		if (machine.state === "started") {
			const image = machine.config?.image ?? "(unknown)";
			if (
				!image.endsWith(":latest") &&
				!image.includes(process.env.FLY_MISSIONS_IMAGE ?? "\0")
			) {
				findings.imageDrift.push({
					missionId: m.missionId,
					machineId: m.machineId,
					image,
				});
			}
		}
	}

	// ── 2. Orphan checks (Fly resources not referenced by any active mission) ──
	const orphans = classifyOrphans({
		machines: flyMachines,
		volumes: flyVolumes,
		referencedMachineIds,
		referencedVolumeIds,
		now: Date.now(),
		minAgeMs: minAgeHours * 3_600_000,
	});
	const orphanMachines = orphans.machines.purge;
	const orphanVolumes = orphans.volumes.purge;
	const skippedCount =
		orphans.machines.skipped.length + orphans.volumes.skipped.length;

	// ── Report ───────────────────────────────────────────────────────────────
	console.log(
		`Active (non-destroyed) missions in Mongo: ${activeMissions.length}`,
	);
	console.log(
		`Fly machines: ${flyMachines.length}  |  Fly volumes: ${flyVolumes.length}\n`,
	);

	if (findings.missingMachine.length > 0) {
		console.log("── Missions whose tracked machine no longer exists on Fly ──");
		for (const f of findings.missingMachine) {
			console.log(
				`  ✗ ${f.missionId} (status: ${f.status}) — machineId ${f.machineId} not found`,
			);
		}
		console.log();
	}

	if (findings.missingVolume.length > 0) {
		console.log(
			"── Missions whose tracked volume does not exist on Fly (data-loss risk on resume) ──",
		);
		for (const f of findings.missingVolume) {
			console.log(
				`  ✗ ${f.missionId} (status: ${f.status}) — volumeId ${f.volumeId} not found. Check \`flyctl volumes list -a ${flyApp}\` for the mission's real volume (often still attached to its current machine) and fix mission.volumeId in MongoDB before the next resume.`,
			);
		}
		console.log();
	}

	if (findings.statusDrift.length > 0) {
		console.log("── Status drift (Mongo vs. real Fly machine state) ──");
		for (const f of findings.statusDrift) {
			console.log(
				`  ⚠ ${f.missionId}: Mongo says "${f.mongoStatus}", Fly machine is "${f.flyState}" (implies "${f.impliedStatus}")`,
			);
		}
		console.log();
	}

	if (findings.staleLocal.length > 0) {
		console.log(
			"── Local-execution missions marked running with no live daemon (this host only) ──",
		);
		for (const f of findings.staleLocal) {
			console.log(`  ⚠ ${f.missionId}: ${f.reason}`);
		}
		console.log();
	}

	if (findings.imageDrift.length > 0) {
		console.log(
			"── Running machines NOT on the :latest (or FLY_MISSIONS_IMAGE) tag ──",
		);
		for (const f of findings.imageDrift) {
			console.log(`  ⚠ ${f.missionId} (machine ${f.machineId}): ${f.image}`);
		}
		console.log(
			"    Likely cause: a bare `flyctl deploy` was run against the missions app directly\n" +
				"    instead of scripts/deploy-missions.sh (see CLAUDE.md). A live machine on a stale\n" +
				"    image will self-heal the next time its mission is suspended and resumed (resume\n" +
				"    always deletes and re-provisions against the current image) — but won't update\n" +
				"    while it keeps running.\n",
		);
	}

	if (orphanMachines.length > 0) {
		console.log(
			"── Fly machines not referenced by any active mission (orphaned, purgeable) ──",
		);
		for (const om of orphanMachines) {
			console.log(
				`  ${purgeOrphans ? "→" : "•"} ${om.id} (${om.name}, state: ${om.state}, image: ${om.config?.image ?? "?"}, created ${om.created_at ?? "?"})`,
			);
		}
		console.log();
	}

	if (orphanVolumes.length > 0) {
		console.log(
			"── Fly volumes not referenced by any active mission (orphaned, purgeable) ──",
		);
		for (const ov of orphanVolumes) {
			console.log(
				`  ${purgeOrphans ? "→" : "•"} ${ov.id} (${ov.name}, created ${ov.created_at ?? "?"})`,
			);
		}
		console.log();
	}

	if (skippedCount > 0) {
		console.log(
			"── Unreferenced Fly resources NOT purgeable (resolve by hand) ──",
		);
		for (const s of orphans.machines.skipped) {
			console.log(
				`  ⚠ machine ${s.resource.id} (${s.resource.name}, state: ${s.resource.state}): ${s.reason}`,
			);
		}
		for (const s of orphans.volumes.skipped) {
			console.log(
				`  ⚠ volume ${s.resource.id} (${s.resource.name}): ${s.reason}`,
			);
		}
		console.log();
	}

	const totalIssues =
		findings.missingMachine.length +
		findings.missingVolume.length +
		findings.statusDrift.length +
		findings.staleLocal.length +
		findings.imageDrift.length +
		orphanMachines.length +
		orphanVolumes.length +
		skippedCount;

	if (totalIssues === 0) {
		console.log("No drift found. Mongo and Fly agree.");
	}

	// ── Apply fixes ──────────────────────────────────────────────────────────
	const reportFix = (missionId, from, to, outcome) => {
		if (outcome === "fixed") console.log(`  ✓ ${missionId}: ${from} → ${to}`);
		else
			console.log(
				`  ↷ ${missionId}: status is no longer "${from}" (changed since the scan) — left untouched`,
			);
	};

	if (fixStatus && findings.statusDrift.length > 0) {
		console.log("\nApplying --fix-status (Fly-backed drift) …");
		for (const f of findings.statusDrift) {
			const outcome = await applyStatusFix(missions, {
				missionId: f.missionId,
				from: f.mongoStatus,
				to: f.impliedStatus,
			});
			reportFix(f.missionId, f.mongoStatus, f.impliedStatus, outcome);
		}
	}

	if (fixStatus && findings.staleLocal.length > 0) {
		// A local-execution mission with no live daemon has no machine to
		// resume automatically (the developer must start it manually again) —
		// "suspended" is the correct rest state, matching what a clean
		// operator-initiated suspend would have left behind.
		console.log("\nApplying --fix-status (stale local-execution missions) …");
		for (const f of findings.staleLocal) {
			const outcome = await applyStatusFix(missions, {
				missionId: f.missionId,
				from: f.status,
				to: "suspended",
			});
			reportFix(f.missionId, f.status, "suspended", outcome);
		}
	}

	if (
		purgeOrphans &&
		!confirmed &&
		(orphanMachines.length > 0 || orphanVolumes.length > 0)
	) {
		console.log(
			`\n--purge-orphans without --yes: the ${orphanMachines.length} machine(s) and ${orphanVolumes.length} volume(s) marked → above would be destroyed. Re-run with --yes to proceed.`,
		);
	}

	if (
		purgeOrphans &&
		confirmed &&
		(orphanMachines.length > 0 || orphanVolumes.length > 0)
	) {
		console.log("\nApplying --purge-orphans …");
		for (const om of orphanMachines) {
			try {
				if (om.state === "started") {
					await flyFetch(`/apps/${flyApp}/machines/${om.id}/stop`, {
						method: "POST",
					});
				}
				await flyFetch(`/apps/${flyApp}/machines/${om.id}?force=true`, {
					method: "DELETE",
				});
				console.log(`  ✓ destroyed machine ${om.id} (${om.name})`);
			} catch (e) {
				console.error(`  ✗ failed to destroy machine ${om.id}: ${e.message}`);
			}
		}
		for (const ov of orphanVolumes) {
			try {
				await flyFetch(`/apps/${flyApp}/volumes/${ov.id}`, {
					method: "DELETE",
				});
				console.log(`  ✓ destroyed volume ${ov.id} (${ov.name})`);
			} catch (e) {
				console.error(`  ✗ failed to destroy volume ${ov.id}: ${e.message}`);
			}
		}
	}

	await client.close();
	// Exit 1 = drift found and nothing was applied (report mode, or a purge
	// plan that still needs --yes), so a cron wrapper can alert on it.
	const applied = fixStatus || (purgeOrphans && confirmed);
	process.exit(totalIssues > 0 && !applied ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
