import { join } from "node:path";
import { entryTrigger } from "@magi/agent-config";
import { controlApp } from "../app-control.js";
import { appsTokenFromEnv, createAppHop } from "../app-hop.js";
import { appProcesses } from "../app-processes.js";
import {
	ensureAppDirs,
	processAppRequests,
	publicStatus,
} from "../app-requests.js";
import { createMongoAppStore, ensureAppIndexes } from "../app-store.js";
import { type AppSupervisor, createAppSupervisor } from "../app-supervisor.js";
import { buildUidToAgentId, resolveLinuxUsers, uidOf } from "../linux-user.js";
import { MISSION_COPILOT_AGENT_ID } from "../mission-copilot.js";
import { mkdirInside, openAppendInside, readInside } from "../safe-path.js";
import type { BootContext } from "./context.js";

const REQUEST_POLL_MS = 5_000;
const HEALTH_CHECK_MS = 15_000;
const LOG_TAIL_BYTES = 4_000;

/**
 * Interactive apps (ADR-0037): mark every record stopped (nothing survives a
 * restart), then poll the request directory and check running apps. Returns
 * the supervisor (for the monitor hop) and a stop that ends both timers and
 * every app.
 */
export async function startApps(
	ctx: Pick<
		BootContext,
		| "db"
		| "missionId"
		| "sharedDir"
		| "workdir"
		| "teamConfig"
		| "mailboxRepo"
		| "firewall"
		| "monitor"
	>,
): Promise<{ apps: AppSupervisor; stopApps: () => Promise<void> }> {
	const { db, missionId, sharedDir, workdir, teamConfig } = ctx;
	await ensureAppIndexes(db);
	const store = createMongoAppStore(db, missionId);
	const reset = await store.markAllStopped();
	if (reset > 0)
		console.log(`[apps] ${reset} app(s) marked stopped after a restart`);
	ensureAppDirs(sharedDir);

	const linuxUsers = resolveLinuxUsers(teamConfig.agents);
	const workdirOf = (agentId: string) => {
		const user = linuxUsers.get(agentId);
		return user
			? join(workdir, "home", user, "missions", missionId)
			: undefined;
	};
	const logFile = (name: string) => `logs/app-${name}.log`;
	const notify = async (agentId: string, subject: string, body: string) => {
		await ctx.mailboxRepo
			.post({ missionId, from: "scheduler", to: [agentId], subject, body })
			.catch((e: Error) =>
				console.error(
					`[apps] could not tell ${agentId} "${subject}": ${e.message}`,
				),
			);
	};
	const limits = teamConfig.mission.apps ?? {};

	const apps = createAppSupervisor({
		store,
		processes: appProcesses,
		firewall: ctx.firewall,
		allowNoFirewall:
			!process.env.FLY_APP_NAME &&
			process.env.APPS_ALLOW_NO_FIREWALL === "true",
		limits: {
			maxRunning: limits.maxRunning ?? 3,
			idleMs: (limits.idleHours ?? 4) * 60 * 60_000,
		},
		linuxUserOf: (id) => linuxUsers.get(id),
		uidOf,
		openLog(owner, name) {
			const root = workdirOf(owner);
			if (!root) throw new Error(`no workdir for ${owner}`);
			mkdirInside(root, "logs", { exclusive: false });
			return openAppendInside(root, logFile(name));
		},
		logTail(owner, name) {
			const root = workdirOf(owner);
			if (!root) return "(no log)";
			try {
				const text = readInside(root, logFile(name)).bytes.toString("utf8");
				return text.slice(-LOG_TAIL_BYTES);
			} catch (e) {
				return `(log unreadable: ${(e as Error).message})`;
			}
		},
		notify,
	});

	const controlDeps = {
		supervisor: apps,
		store,
		actsOnAny: new Set([MISSION_COPILOT_AGENT_ID]),
		notify,
	};
	const requestDeps = {
		...controlDeps,
		sharedDir,
		workdirOf,
		uidToAgentId: buildUidToAgentId(teamConfig.agents),
		daemonUid: process.getuid?.() ?? -1,
	};
	ctx.monitor.apps = {
		hop: createAppHop({
			missionId,
			appsToken: appsTokenFromEnv(),
			route: (cap) => apps.route(cap),
			touch: (name) => apps.touch(name),
		}),
		list: async () => (await store.list()).map(publicStatus),
		control: (name, action) =>
			controlApp(controlDeps, name, action, { kind: "operator" }),
	};
	const { pollTimer, checkTimer } = startAppTimers(requestDeps, apps);
	return {
		apps,
		async stopApps() {
			clearInterval(pollTimer);
			clearInterval(checkTimer);
			await apps.stopAll("the daemon is stopping");
		},
	};
}

/** The request poll and the health check, each skipping a tick while its previous run is still going. */
function startAppTimers(
	requestDeps: Parameters<typeof processAppRequests>[0],
	apps: AppSupervisor,
) {
	let polling = false;
	const pollTimer = setInterval(
		entryTrigger("app.run", async () => {
			if (polling) return;
			polling = true;
			try {
				await processAppRequests(requestDeps);
			} catch (e) {
				console.error(
					`[apps] processing app requests failed: ${(e as Error).message}; retried in ${REQUEST_POLL_MS / 1000} s`,
				);
			} finally {
				polling = false;
			}
		}),
		REQUEST_POLL_MS,
	);
	let checking = false;
	const checkTimer = setInterval(
		entryTrigger("app.run", async () => {
			if (checking) return;
			checking = true;
			try {
				await apps.tick();
			} catch (e) {
				console.error(
					`[apps] the app health check failed: ${(e as Error).message}; retried in ${HEALTH_CHECK_MS / 1000} s`,
				);
			} finally {
				checking = false;
			}
		}),
		HEALTH_CHECK_MS,
	);
	return { pollTimer, checkTimer };
}
