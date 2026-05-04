/**
 * Fly.io Machines API v1 client.
 *
 * Security (S2/S8): targets are always derived from the FLY_MISSIONS_APP_NAME
 * env var and machineIds stored in MongoDB — never from user-supplied parameters.
 * Uses FLY_API_TOKEN_MACHINES (runtime Fly secret), not the CI deploy token.
 */

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
	region?: string;
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
export async function provisionMission(
	missionId: string,
	teamConfigName: string,
	opts: ProvisionOptions = {},
): Promise<MachineHandle> {
	const region = opts.region ?? process.env.FLY_REGION ?? "iad";
	const app = appName();

	// 1. Create workspace volume.
	const volRes = await flyFetch(`/apps/${app}/volumes`, {
		method: "POST",
		body: JSON.stringify({
			name: `workspace_${missionId.replace(/[^a-z0-9_]/gi, "_")}`,
			size_gb: 10,
			region,
		}),
	});
	if (!volRes.ok) {
		const body = await volRes.text();
		throw new Error(`Failed to create volume: ${volRes.status} ${body}`);
	}
	const vol = (await volRes.json()) as { id: string };

	// 2. Build team-config env vars.
	// When a YAML payload is provided (from MongoDB templates), write it to the
	// Fly Volume on first boot instead of reading the baked-in image path.
	// TEAM_SKILLS_PATH keeps skills loading from the image even when YAML is on volume.
	const teamConfigEnv = opts.teamConfigYaml
		? {
				TEAM_CONFIG: "/missions/team.yaml",
				TEAM_CONFIG_YAML: Buffer.from(opts.teamConfigYaml, "utf-8").toString(
					"base64",
				),
				TEAM_SKILLS_PATH: `/app/config/teams/${teamConfigName}/skills`,
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
				mounts: [{ volume: vol.id, path: "/missions" }],
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
		volumeId: vol.id,
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
 * Start (resume) a suspended mission machine.
 * Polls until state == "started" (typically 3–5 s).
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

	// Poll until started (max 30 s).
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 1_000));
		const stateRes = await flyFetch(`/apps/${app}/machines/${machineId}`);
		if (stateRes.ok) {
			const m = (await stateRes.json()) as { state: string };
			if (m.state === "started") return;
		}
	}
	throw new Error(
		`Machine ${machineId} did not reach started state within 30 s`,
	);
}

/** Get the current state of a machine. */
export async function getMachineState(machineId: string): Promise<string> {
	const app = appName();
	const res = await flyFetch(`/apps/${app}/machines/${machineId}`);
	if (!res.ok)
		throw new Error(`Failed to get machine ${machineId}: ${res.status}`);
	const m = (await res.json()) as { state: string };
	return m.state;
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
