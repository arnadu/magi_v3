/**
 * The app supervisor (ADR-0037 decision 6; operations app.run, app.control):
 * starts declared apps as their owners, watches them, restarts a crashed
 * one a few times an hour, stops them on request, when idle and at
 * shutdown, and keeps each record's status in step (catalog entity `app`).
 *
 * What runs lives in memory only: at boot every record is marked stopped
 * (`app-store.ts` markAllStopped), so nothing claims to run that does not.
 */

import { randomBytes } from "node:crypto";
import type { MissionAppDoc } from "@magi/agent-config";
import { appLaunch } from "./app-commands.js";
import type { AppProcesses } from "./app-processes.js";
import type { AppDeclaration, AppStore } from "./app-store.js";
import type { MachineFirewall } from "./machine-firewall.js";

export const FIRST_APP_PORT = 20_000;
export const LAST_APP_PORT = 20_099;
const START_GRACE_MS = 2 * 60_000;
const MISSED_CHECKS_FOR_CRASH = 4;
const RESTARTS_PER_HOUR = 3;
const TERM_GRACE_MS = 10_000;

export interface AppLimits {
	maxRunning: number;
	idleMs: number;
}

export interface SupervisorDeps {
	store: AppStore;
	processes: AppProcesses;
	firewall: Pick<MachineFirewall, "state" | "allow" | "revoke">;
	/** Locally only: run apps with no firewall (`APPS_ALLOW_NO_FIREWALL`). */
	allowNoFirewall: boolean;
	limits: AppLimits;
	linuxUserOf(agentId: string): string | undefined;
	uidOf(linuxUser: string): number;
	/** An fd appending to the app's log in its owner's workdir. */
	openLog(owner: string, name: string): number;
	logTail(owner: string, name: string): string;
	/** Tell an agent something about its app (mail from the platform). */
	notify(agentId: string, subject: string, body: string): Promise<void>;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

interface Live {
	name: string;
	owner: string;
	linuxUser: string;
	port: number;
	pgid: number;
	startedAt: number;
	/** When it last answered, or was opened (the idle clock). */
	lastUsedAt: number;
	misses: number;
	answered: boolean;
	/** Set before a stop we asked for, so the exit is not a crash. */
	stopping: boolean;
	keepPrefix: boolean;
	capability: string;
	jupyterToken?: string;
}

export type Outcome =
	| { ok: true; message: string }
	| { ok: false; message: string };

/** What the monitor hop needs to forward a request to an app. */
export interface AppRoute {
	port: number;
	keepPrefix: boolean;
	jupyterToken?: string;
}

export class AppSupervisor {
	private readonly live = new Map<string, Live>();
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(private readonly deps: SupervisorDeps) {
		this.now = deps.now ?? Date.now;
		this.sleep =
			deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	}

	private firewallReady(): string | null {
		if (this.deps.firewall.state.kind === "on") return null;
		if (
			this.deps.firewall.state.kind === "off-local" &&
			this.deps.allowNoFirewall
		)
			return null;
		return `apps cannot start: the machine firewall is ${this.deps.firewall.state.kind}`;
	}

	private async freePort(): Promise<number | null> {
		const used = new Set([...this.live.values()].map((l) => l.port));
		for (let p = FIRST_APP_PORT; p <= LAST_APP_PORT; p++) {
			if (!used.has(p) && (await this.deps.processes.portFree(p))) return p;
		}
		return null;
	}

	private async launch(app: MissionAppDoc): Promise<Outcome> {
		const linuxUser = this.deps.linuxUserOf(app.owner);
		if (!linuxUser)
			return { ok: false, message: `owner ${app.owner} is not on the roster` };
		const port = await this.freePort();
		if (port === null) return { ok: false, message: "no free app port" };
		const jupyterToken =
			app.kind === "jupyter" ? randomBytes(24).toString("hex") : undefined;
		const l = appLaunch({
			kind: app.kind,
			path: app.path,
			handlers: app.handlers,
			port,
			basePath: `/a/${app.capability}`,
			jupyterToken,
		});
		if (this.deps.firewall.state.kind === "on")
			await this.deps.firewall.allow(port, this.deps.uidOf(linuxUser));
		const child = this.deps.processes.start(
			linuxUser,
			l,
			this.deps.openLog(app.owner, app.name),
		);
		const pgid = child.pid;
		if (pgid === undefined) {
			await this.revoke(port);
			return { ok: false, message: "the app's process did not start" };
		}
		const entry: Live = {
			name: app.name,
			owner: app.owner,
			linuxUser,
			port,
			pgid,
			startedAt: this.now(),
			lastUsedAt: this.now(),
			misses: 0,
			answered: false,
			stopping: false,
			keepPrefix: l.keepPrefix,
			capability: app.capability,
			jupyterToken,
		};
		this.live.set(app.name, entry);
		child.on("error", (e) =>
			console.error(
				`[apps] spawning app ${app.name} for ${app.owner} failed: ${e.message}`,
			),
		);
		child.on("exit", (code, signal) => {
			void this.onExit(entry, `exited (${signal ?? `code ${code}`})`);
		});
		return { ok: true, message: `starting on port ${port}` };
	}

	private async revoke(port: number): Promise<void> {
		if (this.deps.firewall.state.kind !== "on") return;
		try {
			await this.deps.firewall.revoke(port);
		} catch (e) {
			console.error(
				`[apps] revoking port ${port} failed: ${(e as Error).message}; the next app on this port replaces its rule`,
			);
		}
	}

	private async onExit(entry: Live, why: string): Promise<void> {
		if (this.live.get(entry.name) !== entry) return;
		this.live.delete(entry.name);
		await this.revoke(entry.port);
		if (entry.stopping) return;
		await this.crashed(entry, why);
	}

	/** A crash: restart within the hourly limit, else `failed` and tell the owner. */
	private async crashed(entry: Live, why: string): Promise<void> {
		const app = await this.deps.store.get(entry.name);
		if (!app) return;
		const hourAgo = this.now() - 60 * 60_000;
		const restarts = app.restarts.filter((d) => d.getTime() > hourAgo);
		if (restarts.length < RESTARTS_PER_HOUR) {
			console.error(`[apps] app ${entry.name} ${why}; restarting`);
			await this.deps.store.toRestarting(
				entry.name,
				[...restarts, new Date(this.now())],
				why,
			);
			const r = await this.launch(app);
			if (r.ok) return;
			why = `${why}; restart failed: ${r.message}`;
		}
		await this.deps.store.toFailed(entry.name, why);
		await this.deps.notify(
			entry.owner,
			`App ${entry.name} failed`,
			`Your app ${entry.name} ${why}, more often than the restart limit (${RESTARTS_PER_HOUR} an hour) allows. It stays stopped until you start it again.\n\nLast lines of its log:\n${this.deps.logTail(entry.owner, entry.name)}`,
		);
	}

	private async stopLive(entry: Live): Promise<void> {
		entry.stopping = true;
		await this.deps.processes.signal(entry.pgid, entry.linuxUser, "TERM");
		for (let waited = 0; waited < TERM_GRACE_MS; waited += 500) {
			if (this.live.get(entry.name) !== entry) return;
			await this.sleep(500);
		}
		await this.deps.processes.signal(entry.pgid, entry.linuxUser, "KILL");
		if (this.live.get(entry.name) === entry) {
			this.live.delete(entry.name);
			await this.revoke(entry.port);
		}
	}

	async declare(d: AppDeclaration): Promise<Outcome> {
		const existing = await this.deps.store.get(d.name);
		if (existing && existing.owner !== d.owner)
			return {
				ok: false,
				message: `app ${d.name} belongs to ${existing.owner}`,
			};
		const running = this.live.get(d.name);
		if (running) await this.stop(d.name, "redeclared");
		await this.deps.store.declare(d, randomBytes(16).toString("hex"));
		return this.start(d.name);
	}

	async start(name: string): Promise<Outcome> {
		const blocked = this.firewallReady();
		if (blocked) return { ok: false, message: blocked };
		const app = await this.deps.store.get(name);
		if (!app) return { ok: false, message: `no app named ${name}` };
		if (this.live.has(name)) return { ok: true, message: "already running" };
		if (this.live.size >= this.deps.limits.maxRunning)
			return {
				ok: false,
				message: `at most ${this.deps.limits.maxRunning} apps run at once; running now: ${[...this.live.keys()].join(", ")}`,
			};
		if (!(await this.deps.store.toStarting(name, [])))
			return { ok: false, message: `app ${name} changed state; try again` };
		const r = await this.launch(app);
		if (!r.ok) await this.deps.store.toFailed(name, r.message);
		return r;
	}

	async stop(name: string, why: string): Promise<Outcome> {
		const entry = this.live.get(name);
		if (!entry) return { ok: true, message: "not running" };
		await this.stopLive(entry);
		await this.deps.store.toStopped(name);
		console.log(`[apps] app ${name} stopped: ${why}`);
		return { ok: true, message: "stopped" };
	}

	async remove(name: string): Promise<Outcome> {
		await this.stop(name, "removed");
		await this.deps.store.remove(name);
		return { ok: true, message: "removed" };
	}

	/** One app's health and idle check. */
	private async checkOne(entry: Live): Promise<void> {
		if (entry.stopping) return;
		if (await this.deps.processes.answers(entry.port)) {
			entry.misses = 0;
			if (!entry.answered) {
				entry.answered = true;
				entry.lastUsedAt = this.now();
				await this.deps.store.toRunning(entry.name, entry.port);
			}
		} else if (entry.answered) {
			entry.misses++;
		}
		const silent = entry.answered
			? entry.misses >= MISSED_CHECKS_FOR_CRASH
			: this.now() - entry.startedAt > START_GRACE_MS;
		if (silent) {
			entry.stopping = true;
			await this.deps.processes.signal(entry.pgid, entry.linuxUser, "KILL");
			this.live.delete(entry.name);
			await this.revoke(entry.port);
			await this.crashed(
				entry,
				entry.answered ? "stopped answering" : "never answered on its port",
			);
			return;
		}
		if (
			entry.answered &&
			this.now() - entry.lastUsedAt > this.deps.limits.idleMs
		) {
			await this.stop(entry.name, "unopened past the idle time");
			return;
		}
		await this.deps.store.update(entry.name, {
			rssMb: this.deps.processes.rssMb(entry.pgid),
		});
	}

	/** Health and idle checks; the supervisor's tick (every 15 s). */
	async tick(): Promise<void> {
		for (const entry of [...this.live.values()]) await this.checkOne(entry);
	}

	/** The operator opened it: resets the idle clock. */
	touch(name: string): void {
		const entry = this.live.get(name);
		if (entry) entry.lastUsedAt = this.now();
	}

	/** For the monitor hop: the running app with this capability. */
	route(capability: string): (AppRoute & { name: string }) | undefined {
		for (const e of this.live.values())
			if (e.capability === capability && e.answered && !e.stopping)
				return {
					name: e.name,
					port: e.port,
					keepPrefix: e.keepPrefix,
					jupyterToken: e.jupyterToken,
				};
		return undefined;
	}

	running(): string[] {
		return [...this.live.keys()];
	}

	async stopAll(why: string): Promise<void> {
		await Promise.all([...this.live.keys()].map((n) => this.stop(n, why)));
	}
}

export function createAppSupervisor(deps: SupervisorDeps): AppSupervisor {
	return new AppSupervisor(deps);
}
