/**
 * Fly.io Machines API v1 client.
 *
 * Security (S2/S8): targets are always derived from the FLY_MISSIONS_APP_NAME
 * env var and machineIds stored in MongoDB — never from user-supplied parameters.
 * Uses FLY_API_TOKEN_MACHINES (runtime Fly secret), not the CI deploy token.
 *
 * Local execution mode (LOCAL_EXECUTION=true):
 *   Skips all Fly API calls. Writes mission config to LOCAL_MISSIONS_DIR
 *   (default: ~/.magi/local/{missionId}/). The developer starts the daemon
 *   manually; the control plane proxy routes dashboard traffic to 127.0.0.1:4000.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deriveMonitorToken } from "./monitor-token.js";

const FLY_API_BASE = "https://api.machines.dev/v1";

function appName(): string {
	const name = process.env.FLY_MISSIONS_APP_NAME;
	if (!name) throw new Error("FLY_MISSIONS_APP_NAME is not set");
	return name;
}

function apiToken(): string {
	const token = process.env.FLY_API_TOKEN_MACHINES;
	if (!token) throw new Error("FLY_API_TOKEN_MACHINES is not set");
	return token;
}

async function flyFetch(
	path: string,
	options: RequestInit = {},
): Promise<Response> {
	const url = `${FLY_API_BASE}${path}`;
	const res = await fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${apiToken()}`,
			"Content-Type": "application/json",
			...options.headers,
		},
	});
	return res;
}

export interface MachineHandle {
	machineId: string;
	privateIp: string;
	volumeId: string;
}

export interface ProvisionOptions {
	/** base64-encoded team config YAML from MongoDB templates. When provided the
	 *  daemon writes it to /missions/team.yaml on first boot instead of reading
	 *  the baked-in image path. */
	teamConfigYaml?: string;
	/** All files from config/teams/{id}/ — skills, playbook.json, etc. When
	 *  provided the daemon writes them to /missions/team/ on first boot so the
	 *  entire team setup is volume-based and image-independent. */
	teamFiles?: Array<{ path: string; content: string }>;
	region?: string;
	/** When set, skip volume creation and attach this existing volume instead.
	 *  Used when re-provisioning a machine whose Fly machine was deleted but
	 *  whose workspace volume is still intact. */
	existingVolumeId?: string;
}

/**
 * Provision a new execution plane machine for a mission.
 *
 * Steps:
 *   1. Create a Fly Volume (10 GB) for workspace persistence.
 *   2. Create a Machine attached to the volume.
 *   3. Return machineId, privateIp, volumeId for storage in MongoDB.
 *
 * When opts.teamConfigYaml is provided the machine receives TEAM_CONFIG_YAML
 * (base64) + TEAM_SKILLS_PATH (image path) so the daemon writes the YAML to
 * the volume on first boot and still finds skills in the image.
 */

/**
 * Build a Fly volume name from a missionId.
 * Fly Volumes API constraint: lowercase [a-z0-9_], max 30 chars.
 * missionId format: {template}-{YYYYMMDD}-{4hex}
 * Strategy: hyphens → underscores, lowercase; if > 30 chars keep first 16 + last 14
 * (_YYYYMMDD_xxxx) so the unique timestamp suffix is always preserved.
 */
function flyVolumeName(missionId: string): string {
	const slug = missionId.toLowerCase().replace(/-/g, "_");
	// 14 = length of "_YYYYMMDD_xxxx" tail; 30 - 14 = 16 chars for the prefix.
	return slug.length <= 30 ? slug : `${slug.slice(0, 16)}${slug.slice(-14)}`;
}

export async function provisionMission(
	missionId: string,
	teamConfigName: string,
	opts: ProvisionOptions = {},
): Promise<MachineHandle> {
	const region = opts.region ?? process.env.FLY_REGION ?? "iad";
	const app = appName();

	// 1. Create workspace volume — or reuse an existing one when re-provisioning.
	let volumeId: string;
	if (opts.existingVolumeId) {
		volumeId = opts.existingVolumeId;
		console.log(
			`[fly-machines] re-provisioning ${missionId} with existing volume ${volumeId}`,
		);
	} else {
		const volRes = await flyFetch(`/apps/${app}/volumes`, {
			method: "POST",
			body: JSON.stringify({
				name: flyVolumeName(missionId),
				size_gb: 10,
				region,
			}),
		});
		if (!volRes.ok) {
			const body = await volRes.text();
			if (volRes.status === 401) {
				throw new Error(
					"Fly API returned 401 — check FLY_API_TOKEN_MACHINES. Cannot provision missions with a dummy token.",
				);
			}
			throw new Error(`Failed to create volume: ${volRes.status} ${body}`);
		}
		const vol = (await volRes.json()) as { id: string };
		volumeId = vol.id;
	}

	// 2. Build team-config env vars.
	// When YAML + files are provided (from MongoDB templates), the daemon writes
	// them to /missions/team.yaml and /missions/team/* on first boot.
	// teamDir is derived from TEAM_CONFIG path: dirname + basename without .yaml,
	// so /missions/team.yaml → teamDir = /missions/team — playbook.json, skills/
	// all resolve correctly without any extra path overrides.
	const teamConfigEnv = opts.teamConfigYaml
		? {
				TEAM_CONFIG: "/missions/team.yaml",
				TEAM_CONFIG_YAML: Buffer.from(opts.teamConfigYaml, "utf-8").toString(
					"base64",
				),
				...(opts.teamFiles && opts.teamFiles.length > 0
					? {
							TEAM_FILES_PAYLOAD: Buffer.from(
								JSON.stringify(opts.teamFiles),
								"utf-8",
							).toString("base64"),
						}
					: {}),
			}
		: {
				TEAM_CONFIG: `/app/config/teams/${teamConfigName}.yaml`,
			};

	// 3. Create machine.
	const machineRes = await flyFetch(`/apps/${app}/machines`, {
		method: "POST",
		body: JSON.stringify({
			config: {
				// FLY_MISSIONS_IMAGE overrides the default :latest tag; useful when
				// the latest CI build tag hasn't been aliased to :latest yet.
				image:
					process.env.FLY_MISSIONS_IMAGE ?? `registry.fly.io/${app}:latest`,
				env: {
					MISSION_ID: missionId,
					...teamConfigEnv,
					AGENT_WORKDIR: "/missions",
					MONITOR_PORT: "4000",
					TOOL_PORT: "4001",
					// Per-mission auth token for MonitorServer mutating routes.
					// Derived from MONITOR_SIGNING_KEY (control plane only) — never stored in MongoDB.
					MONITOR_TOKEN: deriveMonitorToken(missionId),
					// Pass runtime secrets explicitly — Fly app-level secrets are NOT
					// automatically injected into machines created via the Machines API.
					ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
					MONGODB_URI: process.env.MONGODB_URI ?? "",
					BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY ?? "",
					OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
					FRED_API_KEY: process.env.FRED_API_KEY ?? "",
					FMP_API_KEY: process.env.FMP_API_KEY ?? "",
					NEWSAPIORG_API_KEY: process.env.NEWSAPIORG_API_KEY ?? "",
				},
				mounts: [{ volume: volumeId, path: "/missions" }],
				restart: { policy: "on-failure", max_retries: 3 },
				// No services — internal access only via WireGuard.
				// 1 GB RAM: Node + MongoDB driver + agent pool need ~600 MB at idle;
				// Playwright/Chromium adds another ~400 MB under load.
				guest: {
					cpu_kind: "shared",
					cpus: 1,
					memory_mb: 1024,
				},
			},
			region,
		}),
	});
	if (!machineRes.ok) {
		const body = await machineRes.text();
		throw new Error(`Failed to create machine: ${machineRes.status} ${body}`);
	}
	const machine = (await machineRes.json()) as {
		id: string;
		private_ip: string;
	};

	return {
		machineId: machine.id,
		privateIp: machine.private_ip,
		volumeId,
	};
}

/** Stop (suspend) a running mission machine. */
export async function suspendMission(machineId: string): Promise<void> {
	const app = appName();
	const res = await flyFetch(`/apps/${app}/machines/${machineId}/stop`, {
		method: "POST",
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(
			`Failed to stop machine ${machineId}: ${res.status} ${body}`,
		);
	}
}

/**
 * Update the TEAM_CONFIG_YAML (and optionally TEAM_FILES_PAYLOAD) env vars on a
 * suspended machine so that the daemon overwrites /missions/team.yaml on next boot.
 * Uses Fly Machines PATCH which merges env — only the specified keys are overwritten.
 */
export async function updateMachineTeamConfig(
	machineId: string,
	teamConfigYaml: string,
	teamFiles?: Array<{ path: string; content: string }>,
): Promise<void> {
	const app = appName();
	const env: Record<string, string> = {
		TEAM_CONFIG_YAML: Buffer.from(teamConfigYaml, "utf-8").toString("base64"),
	};
	if (teamFiles && teamFiles.length > 0) {
		env.TEAM_FILES_PAYLOAD = Buffer.from(
			JSON.stringify(teamFiles),
			"utf-8",
		).toString("base64");
	}
	const res = await flyFetch(`/apps/${app}/machines/${machineId}`, {
		method: "PATCH",
		body: JSON.stringify({ config: { env } }),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(
			`Failed to update machine config ${machineId}: ${res.status} ${body}`,
		);
	}
}

/**
 * Start (resume) a suspended mission machine.
 * Returns as soon as Fly accepts the start request — does not poll for
 * "started" state to avoid exceeding Fly's ~25 s HTTP proxy timeout.
 * Callers that need to confirm the machine is running should poll
 * getMachineState() independently.
 */
export async function resumeMission(machineId: string): Promise<void> {
	const app = appName();
	const startRes = await flyFetch(`/apps/${app}/machines/${machineId}/start`, {
		method: "POST",
	});
	if (!startRes.ok) {
		const body = await startRes.text();
		throw new Error(
			`Failed to start machine ${machineId}: ${startRes.status} ${body}`,
		);
	}
}

/** Get the current state of a machine. Skips Fly for local machines. */
export async function getMachineState(machineId: string): Promise<string> {
	if (machineId.startsWith("local-")) return "started";
	const app = appName();
	const res = await flyFetch(`/apps/${app}/machines/${machineId}`);
	if (!res.ok)
		throw new Error(`Failed to get machine ${machineId}: ${res.status}`);
	const m = (await res.json()) as { state: string };
	return m.state;
}

// ---------------------------------------------------------------------------
// Local execution mode (LOCAL_EXECUTION=true)
// ---------------------------------------------------------------------------

export function isLocalExecution(): boolean {
	return process.env.LOCAL_EXECUTION === "true";
}

function localMissionsDir(): string {
	return process.env.LOCAL_MISSIONS_DIR ?? join(homedir(), ".magi", "local");
}

/**
 * Provision a local mission by writing config files to disk and returning a
 * fake MachineHandle pointing at 127.0.0.1. The developer must start the
 * daemon manually using the printed command.
 */
export function provisionLocal(
	missionId: string,
	opts: ProvisionOptions,
): MachineHandle {
	const missionDir = join(localMissionsDir(), missionId);
	mkdirSync(missionDir, { recursive: true });

	if (opts.teamConfigYaml) {
		writeFileSync(join(missionDir, "team.yaml"), opts.teamConfigYaml, "utf-8");
	}
	if (opts.teamFiles && opts.teamFiles.length > 0) {
		for (const f of opts.teamFiles) {
			const dest = join(missionDir, "team", f.path);
			mkdirSync(join(dest, ".."), { recursive: true });
			writeFileSync(dest, f.content, "utf-8");
		}
	}

	console.log(`[local-provision] Mission files written to: ${missionDir}`);
	console.log(
		`[local-provision] Start the daemon in a separate terminal:\n` +
			`  TEAM_CONFIG=${join(missionDir, "team.yaml")} \\\n` +
			`  npm run daemon -w packages/agent-runtime-worker`,
	);

	return {
		machineId: `local-${missionId}`,
		privateIp: "127.0.0.1",
		volumeId: `local-${missionId}`,
	};
}

/** Delete local mission files (best-effort). */
export function destroyLocal(missionId: string): void {
	const missionDir = join(localMissionsDir(), missionId);
	try {
		rmSync(missionDir, { recursive: true, force: true });
	} catch {
		// Non-fatal — directory may not exist.
	}
}

/** Update local mission files when config is edited and mission is resumed. */
export function updateLocalMissionConfig(
	missionId: string,
	teamConfigYaml: string,
	teamFiles?: Array<{ path: string; content: string }>,
): void {
	const missionDir = join(localMissionsDir(), missionId);
	mkdirSync(missionDir, { recursive: true });
	writeFileSync(join(missionDir, "team.yaml"), teamConfigYaml, "utf-8");
	if (teamFiles && teamFiles.length > 0) {
		for (const f of teamFiles) {
			const dest = join(missionDir, "team", f.path);
			mkdirSync(join(dest, ".."), { recursive: true });
			writeFileSync(dest, f.content, "utf-8");
		}
	}
}

/** Destroy a mission machine and its associated volume (irreversible). */
export async function destroyMission(
	machineId: string,
	volumeId: string,
): Promise<void> {
	const app = appName();

	// Stop first if running.
	try {
		await suspendMission(machineId);
		await new Promise((r) => setTimeout(r, 2_000));
	} catch {
		// Already stopped — proceed.
	}

	const machineRes = await flyFetch(`/apps/${app}/machines/${machineId}`, {
		method: "DELETE",
		body: JSON.stringify({ kill: true }),
	});
	if (!machineRes.ok && machineRes.status !== 404) {
		const body = await machineRes.text();
		throw new Error(
			`Failed to delete machine ${machineId}: ${machineRes.status} ${body}`,
		);
	}

	const volRes = await flyFetch(`/apps/${app}/volumes/${volumeId}`, {
		method: "DELETE",
	});
	if (!volRes.ok && volRes.status !== 404) {
		const body = await volRes.text();
		throw new Error(
			`Failed to delete volume ${volumeId}: ${volRes.status} ${body}`,
		);
	}
}
