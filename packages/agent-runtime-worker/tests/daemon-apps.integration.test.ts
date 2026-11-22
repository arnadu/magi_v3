/**
 * Integration test: interactive apps on a real daemon (ADR-0037), no LLM.
 *
 * The test plays the agent: it runs the platform's own `serve-app.sh` and
 * `python-env.sh` as the agent's OS user (through `magi-app`, the daemon's
 * own sudo rule), and plays the apps host by calling the monitor server's
 * hop with the apps token. It checks, end to end on one machine:
 *   - A-10: a request file declares and starts a `site` app as its owner;
 *     the status file and the `missionApps` record agree;
 *   - J-22: the hop serves the app only with the apps token and the
 *     mission's id; the monitor token does not open it;
 *   - app.as-owner: the app runs with its owner's own Python once it has one;
 *   - app.bounded: a start beyond `mission.apps.maxRunning` is refused,
 *     naming the apps running; stop frees the port; remove deletes the record.
 *
 * Runs without the machine firewall (`APPS_ALLOW_NO_FIREWALL`): the firewall
 * is root's on a Fly machine and is checked live.
 *
 * Requires: MONGODB_URI in .env; scripts/setup-dev.sh (pool user magi-w1, the
 * magi-app wrapper and its sudo rule, the platform venv).
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MissionAppDoc } from "@magi/agent-config";
import type { Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectMongo } from "../src/mongo.js";

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI)
	throw new Error("MONGODB_URI is required for integration tests");

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const TEAM_CONFIG = join(REPO_ROOT, "config/teams/test/apps.yaml");
const MISSION_ID = "apps-test";
const AGENT = "app-builder";
const AGENT_USER = "magi-w1";
const MONITOR_PORT = 4020;
const TOOL_PORT = 4021;
const APPS_TOKEN = "integration-apps-token";
const WORKDIR = join(tmpdir(), "magi-apps-test");
const SHARED = join(WORKDIR, "missions", MISSION_ID, "shared");
const AGENT_WORKDIR = join(WORKDIR, "home", AGENT_USER, "missions", MISSION_ID);
const SKILLS = join(SHARED, "skills/_platform");

/** Run a shell command as the agent, the way the daemon runs its apps. */
function asAgent(script: string, timeoutMs = 120_000): string {
	return execFileSync(
		"sudo",
		[
			"-n",
			"-u",
			AGENT_USER,
			"/usr/local/bin/magi-app",
			"/usr/bin/env",
			`SHARED_DIR=${SHARED}`,
			`WORKDIR=${AGENT_WORKDIR}`,
			"/bin/bash",
			"-c",
			script,
		],
		{ encoding: "utf8", timeout: timeoutMs },
	);
}

function serveApp(args: string): string {
	return asAgent(`bash ${SKILLS}/serve-app/scripts/serve-app.sh ${args} 2>&1`);
}

async function waitFor<T>(
	what: string,
	probe: () => Promise<T | undefined>,
	timeoutMs = 60_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = await probe().catch(() => undefined);
		if (v !== undefined) return v;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`timed out waiting for ${what}`);
}

function portOpen(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const s = createConnection({ host: "127.0.0.1", port });
		s.once("connect", () => {
			s.destroy();
			resolve(true);
		});
		s.once("error", () => resolve(false));
	});
}

function hop(
	capability: string,
	path: string,
	headers: Record<string, string>,
): Promise<Response> {
	return fetch(`http://127.0.0.1:${MONITOR_PORT}/a/${capability}/${path}`, {
		headers,
		redirect: "manual",
	});
}

const appsHeaders = {
	"x-apps-token": APPS_TOKEN,
	"x-apps-mission": MISSION_ID,
};

/** A site folder in the agent's workdir, written as the agent. */
function writeSite(name: string, text: string): string {
	const dir = join(AGENT_WORKDIR, "apps", name);
	asAgent(`mkdir -p ${dir} && printf '%s' '${text}' > ${dir}/index.html`);
	return dir;
}

describe("integration: interactive apps on the daemon (ADR-0037)", () => {
	let daemon: ChildProcess | null = null;
	let client: MongoClient;
	let db: Db;
	const record = (name: string) =>
		db
			.collection<MissionAppDoc>("missionApps")
			.findOne({ missionId: MISSION_ID, name });

	beforeAll(async () => {
		// The previous run's apps ran as the agent: remove its files as the agent.
		if (existsSync(AGENT_WORKDIR)) asAgent(`rm -rf ${AGENT_WORKDIR}/*`);
		rmSync(WORKDIR, { recursive: true, force: true });
		// biome-ignore lint/style/noNonNullAssertion: checked at module load
		({ client, db } = await connectMongo(MONGODB_URI!));
		for (const c of ["missionApps", "mailbox", "conversationMessages"])
			await db.collection(c).deleteMany({ missionId: MISSION_ID });

		daemon = spawn(
			"node",
			["--import", "./dist/node-polyfill.js", "dist/daemon.js"],
			{
				cwd: join(REPO_ROOT, "packages/agent-runtime-worker"),
				env: {
					...process.env,
					TEAM_CONFIG,
					AGENT_WORKDIR: WORKDIR,
					MONITOR_PORT: String(MONITOR_PORT),
					TOOL_PORT: String(TOOL_PORT),
					APPS_TOKEN,
					APPS_ALLOW_NO_FIREWALL: "true",
					MONITOR_TOKEN: "",
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		daemon.stdout?.on("data", (d: Buffer) =>
			process.stdout.write(`[daemon] ${d}`),
		);
		daemon.stderr?.on("data", (d: Buffer) =>
			process.stderr.write(`[daemon:err] ${d}`),
		);
		await waitFor("the monitor server", async () =>
			(await fetch(`http://127.0.0.1:${MONITOR_PORT}/status`)).ok
				? true
				: undefined,
		);
		await waitFor("the agent's workdir and the platform skills", async () =>
			existsSync(AGENT_WORKDIR) &&
			existsSync(join(SKILLS, "serve-app/scripts/serve-app.sh"))
				? true
				: undefined,
		);
	}, 120_000);

	afterAll(async () => {
		if (daemon) {
			daemon.kill("SIGTERM");
			await new Promise((r) => setTimeout(r, 3_000));
		}
		await db?.collection("missionApps").deleteMany({ missionId: MISSION_ID });
		await client?.close();
	}, 30_000);

	it("A-10: an agent declares a site; it runs as its owner and its record agrees", async () => {
		const dir = writeSite("menu", "<h1>Menu of the day</h1>");
		const out = serveApp(`declare menu --kind site --path ${dir}`);
		expect(out).toContain("menu (site, owner app-builder): running");

		const doc = await record("menu");
		expect(doc).toMatchObject({
			owner: AGENT,
			kind: "site",
			path: dir,
			status: "running",
		});
		expect(doc?.capability).toMatch(/^[0-9a-f]{32}$/);
		const status = JSON.parse(
			readFileSync(join(SHARED, "apps/status/menu.json"), "utf8"),
		);
		expect(status).toMatchObject({ name: "menu", status: "running" });
		expect(JSON.stringify(status)).not.toContain(doc?.capability as string);
	}, 180_000);

	it("J-22: the hop serves the app with the apps token only", async () => {
		const doc = await record("menu");
		const cap = doc?.capability as string;
		const ok = await hop(cap, "", appsHeaders);
		expect(ok.status).toBe(200);
		expect(await ok.text()).toContain("Menu of the day");

		const noToken = await hop(cap, "", { "x-apps-mission": MISSION_ID });
		expect(noToken.status).toBeGreaterThanOrEqual(400);
		const otherMission = await hop(cap, "", {
			...appsHeaders,
			"x-apps-mission": "another-mission",
		});
		expect(otherMission.status).toBeGreaterThanOrEqual(400);
		const monitorToken = await hop(cap, "", {
			"x-monitor-token": "anything",
			"x-apps-mission": MISSION_ID,
		});
		expect(monitorToken.status).toBeGreaterThanOrEqual(400);
		const unknownApp = await hop("0".repeat(32), "", appsHeaders);
		expect(unknownApp.status).toBeGreaterThanOrEqual(400);
	}, 60_000);

	it("app.as-owner: an app runs with its owner's own Python once it has one", async () => {
		asAgent(`bash ${SKILLS}/python-env/scripts/python-env.sh create`);
		const own = join(AGENT_WORKDIR, ".venv/bin/python3");
		expect(existsSync(own)).toBe(true);
		expect(
			asAgent(`magi-python3 -c 'import sys; print(sys.executable)'`).trim(),
		).toBe(own);

		serveApp("stop menu");
		serveApp("start menu");
		const doc = await record("menu");
		const args = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
			.split("\n")
			.find(
				// The app itself, not the sudo that started it.
				(l) =>
					!l.startsWith("sudo") &&
					l.includes("serve-site.py") &&
					l.includes(doc?.path ?? ""),
			);
		expect(args?.split(" ")[0]).toBe(own);
	}, 240_000);

	it("app.bounded: a start beyond the limit is refused, naming the apps running", async () => {
		serveApp(
			`declare specials --kind site --path ${writeSite("specials", "<p>specials</p>")}`,
		);
		const third = writeSite("wine", "<p>wine</p>");
		let refused = "";
		try {
			serveApp(`declare wine --kind site --path ${third}`);
		} catch (e) {
			refused = String((e as { stdout?: string }).stdout ?? e);
		}
		expect(refused).toMatch(
			/Refused: .*running now: (menu, specials|specials, menu)/,
		);
	}, 240_000);

	it("stop frees the port; remove deletes the record", async () => {
		const port = (await record("specials"))?.port as number;
		expect(await portOpen(port)).toBe(true);
		serveApp("stop specials");
		expect((await record("specials"))?.status).toBe("stopped");
		await waitFor("the port to close", async () =>
			(await portOpen(port)) ? undefined : true,
		);
		serveApp("remove specials");
		expect(await record("specials")).toBeNull();
	}, 120_000);
});
