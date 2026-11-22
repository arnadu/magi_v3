import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AppStatus, MissionAppDoc } from "@magi/agent-config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	APP_ENV_KEEP,
	type AppLaunch,
	appLaunch,
	PLATFORM_PYTHON,
} from "../src/app-commands.js";
import type { AppProcesses } from "../src/app-processes.js";
import type { AppStore } from "../src/app-store.js";
import { createAppSupervisor } from "../src/app-supervisor.js";

function memoryStore(): AppStore & { docs: Map<string, MissionAppDoc> } {
	const docs = new Map<string, MissionAppDoc>();
	const move = (
		n: string,
		from: AppStatus[],
		to: AppStatus,
		fields: Partial<MissionAppDoc>,
	) => {
		const d = docs.get(n);
		if (!d || !from.includes(d.status)) return false;
		docs.set(n, { ...d, ...fields, status: to });
		return true;
	};
	return {
		docs,
		get: async (n) =>
			docs.has(n) ? { ...(docs.get(n) as MissionAppDoc) } : null,
		list: async () => [...docs.values()],
		async declare(d, capability) {
			const prev = docs.get(d.name);
			const now = new Date();
			const doc: MissionAppDoc = prev
				? { ...prev, ...d, updatedAt: now }
				: {
						missionId: "m1",
						...d,
						capability,
						status: "stopped",
						restarts: [],
						declaredAt: now,
						statusChangedAt: now,
						updatedAt: now,
					};
			docs.set(d.name, doc);
			return doc;
		},
		toStarting: async (n, restarts) =>
			move(n, ["stopped", "failed"], "starting", { restarts }),
		toRestarting: async (n, restarts, lastError) =>
			move(n, ["running", "starting"], "starting", { restarts, lastError }),
		toRunning: async (n, port) => move(n, ["starting"], "running", { port }),
		toFailed: async (n, lastError) =>
			move(n, ["starting", "running"], "failed", { lastError }),
		toStopped: async (n) => move(n, ["starting", "running"], "stopped", {}),
		async update(n, fields) {
			const d = docs.get(n);
			if (d) docs.set(n, { ...d, ...fields });
		},
		async remove(n) {
			docs.delete(n);
		},
		async markAllStopped() {
			return 0;
		},
	};
}

function fakeProcesses() {
	let nextPid = 1000;
	const children = new Map<number, EventEmitter>();
	const up = new Set<number>();
	const launched: Array<{ user: string; launch: AppLaunch }> = [];
	const signals: string[] = [];
	const processes: AppProcesses = {
		start(user, launch) {
			const c = new EventEmitter() as ChildProcess;
			(c as { pid?: number }).pid = nextPid++;
			children.set(c.pid as number, c);
			launched.push({ user, launch });
			return c;
		},
		async signal(pgid, _user, sig) {
			signals.push(`${sig} ${pgid}`);
			children.get(pgid)?.emit("exit", null, `SIG${sig}`);
			return true;
		},
		answers: async (port) => up.has(port),
		portFree: async () => true,
		rssMb: () => 42,
	};
	const exit = (pid: number) => children.get(pid)?.emit("exit", 1, null);
	return { processes, up, launched, signals, exit };
}

describe("app supervisor", () => {
	let store: ReturnType<typeof memoryStore>;
	let p: ReturnType<typeof fakeProcesses>;
	let clock: number;
	const firewall = {
		state: { kind: "on" as const },
		allow: vi.fn(async () => {}),
		revoke: vi.fn(async () => {}),
	};
	const notify = vi.fn(async () => {});
	const make = (
		over: Partial<Parameters<typeof createAppSupervisor>[0]> = {},
	) =>
		createAppSupervisor({
			store,
			processes: p.processes,
			firewall,
			allowNoFirewall: false,
			limits: { maxRunning: 2, idleMs: 60 * 60_000 },
			linuxUserOf: (id) => ({ analyst: "magi-w1", writer: "magi-w2" })[id],
			uidOf: (u) => (u === "magi-w1" ? 60001 : 60002),
			openLog: () => 1,
			logTail: () => "Traceback: boom",
			pythonOf: (owner) =>
				owner === "writer" ? "/w2/.venv/bin/python3" : PLATFORM_PYTHON,
			notify,
			now: () => clock,
			sleep: async () => {},
			...over,
		});
	const declaration = (name: string, owner = "analyst") => ({
		name,
		owner,
		kind: "gradio" as const,
		path: `/w/${name}.py`,
		description: "",
	});
	const status = (n: string): AppStatus | undefined =>
		store.docs.get(n)?.status;

	beforeEach(() => {
		store = memoryStore();
		p = fakeProcesses();
		clock = 1_000_000;
		firewall.allow.mockClear();
		firewall.revoke.mockClear();
		notify.mockClear();
	});

	it("app.as-owner: starts a declared app as its owner's user, opening its port to the owner only", async () => {
		const s = make();
		expect(await s.declare(declaration("dash"))).toMatchObject({ ok: true });
		expect(p.launched[0].user).toBe("magi-w1");
		expect(firewall.allow).toHaveBeenCalledWith(20_000, 60001);
		expect(status("dash")).toBe("starting");
		p.up.add(20_000);
		await s.tick();
		expect(status("dash")).toBe("running");
		expect(s.route(store.docs.get("dash")?.capability ?? "")).toMatchObject({
			port: 20_000,
			keepPrefix: false,
		});
	});

	it("app.as-owner: an app's environment holds only the app variables, no secrets", () => {
		for (const kind of ["jupyter", "gradio", "site"] as const) {
			const l = appLaunch({
				kind,
				path: "/w/x",
				port: 20_001,
				basePath: "/a/cap",
				jupyterToken: "t",
				python: PLATFORM_PYTHON,
			});
			for (const k of Object.keys(l.env)) expect(APP_ENV_KEEP).toContain(k);
		}
	});

	it("app.loopback-only: every kind is told to listen on 127.0.0.1", () => {
		const j = appLaunch({
			kind: "jupyter",
			path: "/w",
			port: 20_001,
			basePath: "/a/c",
			jupyterToken: "secret-token-1234",
			python: PLATFORM_PYTHON,
		});
		expect(j.argv).toContain("--ServerApp.ip=127.0.0.1");
		expect(j.argv.join(" ")).not.toContain("secret-token-1234");
		const g = appLaunch({
			kind: "gradio",
			path: "/w/a.py",
			port: 20_001,
			basePath: "/a/c",
			python: PLATFORM_PYTHON,
		});
		expect(g.env.GRADIO_SERVER_NAME).toBe("127.0.0.1");
		expect(g.env.GRADIO_RUN_HISTORY).toBe("False");
	});

	it("runs an app with its owner's Python, and JupyterLab with the platform's extensions", async () => {
		const s = make();
		await s.declare(declaration("mine", "writer"));
		await s.declare(declaration("theirs", "analyst"));
		expect(p.launched.map((l) => l.launch.argv[0])).toEqual([
			"/w2/.venv/bin/python3",
			PLATFORM_PYTHON,
		]);
		const j = appLaunch({
			kind: "jupyter",
			path: "/w",
			port: 20_001,
			basePath: "/a/c",
			jupyterToken: "t",
			python: "/w2/.venv/bin/python3",
		});
		expect(j.argv.slice(0, 3)).toEqual([
			"/w2/.venv/bin/python3",
			"-m",
			"jupyterlab",
		]);
		expect(j.env.JUPYTER_PATH).toBe("/opt/magi/venv/share/jupyter");
		// F-082: no module planted in the served folder runs at startup.
		expect(j.env.PYTHONSAFEPATH).toBe("1");
	});

	it("refuses another agent's app on re-declaration", async () => {
		const s = make();
		await s.declare(declaration("dash"));
		expect(await s.declare(declaration("dash", "writer"))).toMatchObject({
			ok: false,
			message: expect.stringContaining("belongs to analyst"),
		});
	});

	it("app.bounded: refuses a start past the limit, naming the apps running", async () => {
		const s = make();
		await s.declare(declaration("a"));
		await s.declare(declaration("b"));
		expect(await s.declare(declaration("c"))).toMatchObject({
			ok: false,
			message: expect.stringMatching(/at most 2 .* running now: a, b/),
		});
	});

	it("app.bounded: restarts a crashed app three times an hour, then fails it and tells the owner", async () => {
		const s = make();
		await s.declare(declaration("dash"));
		for (let i = 0; i < 3; i++) {
			p.exit(1000 + i);
			await vi.waitFor(() => expect(p.launched).toHaveLength(i + 2));
		}
		expect(status("dash")).toBe("starting");
		p.exit(1003);
		await vi.waitFor(() => expect(status("dash")).toBe("failed"));
		expect(p.launched).toHaveLength(4);
		expect(notify).toHaveBeenCalledWith(
			"analyst",
			"App dash failed",
			expect.stringContaining("Traceback: boom"),
		);
		expect(firewall.revoke).toHaveBeenCalledWith(20_000);
	});

	it("app.bounded: a crash before the first answer counts against the restart limit", async () => {
		const s = make();
		await s.declare(declaration("dash"));
		expect(status("dash")).toBe("starting");
		p.exit(1000);
		await vi.waitFor(() => expect(p.launched).toHaveLength(2));
		expect(status("dash")).toBe("starting");
		expect(store.docs.get("dash")?.restarts).toHaveLength(1);
		expect(store.docs.get("dash")?.lastError).toBeTruthy();
	});

	it("re-declaring a running app stops the old process before starting the new one", async () => {
		const s = make();
		await s.declare(declaration("dash"));
		p.up.add(20_000);
		await s.tick();
		expect(status("dash")).toBe("running");
		await s.declare({ ...declaration("dash"), path: "/w/dash-v2.py" });
		expect(p.signals).toEqual(["TERM 1000"]);
		expect(p.launched).toHaveLength(2);
		expect(p.launched[1].launch.argv).toContain("/w/dash-v2.py");
		expect(s.running()).toHaveLength(1);
	});

	it("app.bounded: an app that never answers within two minutes counts as a crash", async () => {
		const s = make();
		await s.declare(declaration("dash"));
		clock += 2 * 60_000 + 1;
		await s.tick();
		expect(p.signals).toContain("KILL 1000");
		expect(p.launched).toHaveLength(2);
		expect(store.docs.get("dash")?.lastError).toBe(
			"never answered on its port",
		);
	});

	it("app.bounded: stops an app unopened past the idle time, and opening it resets the clock", async () => {
		const s = make();
		await s.declare(declaration("dash"));
		p.up.add(20_000);
		await s.tick();
		clock += 50 * 60_000;
		s.touch("dash");
		clock += 50 * 60_000;
		await s.tick();
		expect(status("dash")).toBe("running");
		clock += 11 * 60_000;
		await s.tick();
		expect(status("dash")).toBe("stopped");
		expect(p.signals).toEqual(["TERM 1000"]);
		expect(firewall.revoke).toHaveBeenCalledWith(20_000);
	});

	it("records when an app was opened, at most once a minute", async () => {
		const s = make();
		await s.declare(declaration("dash"));
		s.touch("dash");
		await Promise.resolve();
		expect(store.docs.get("dash")?.lastOpenedAt).toEqual(new Date(clock));
		const first = clock;
		clock += 30_000;
		s.touch("dash");
		await Promise.resolve();
		expect(store.docs.get("dash")?.lastOpenedAt).toEqual(new Date(first));
		clock += 31_000;
		s.touch("dash");
		await Promise.resolve();
		expect(store.docs.get("dash")?.lastOpenedAt).toEqual(new Date(clock));
	});

	it("stop and remove: TERM to the group, record stopped, then deleted", async () => {
		const s = make();
		await s.declare(declaration("dash"));
		expect(await s.stop("dash", "by the operator")).toMatchObject({ ok: true });
		expect(status("dash")).toBe("stopped");
		expect(s.running()).toEqual([]);
		await s.remove("dash");
		expect(store.docs.has("dash")).toBe(false);
	});

	it("starts nothing when the firewall is not on (unless allowed locally)", async () => {
		const failed = make({
			firewall: { ...firewall, state: { kind: "failed", reason: "x" } },
		});
		await store.declare(declaration("dash"), "cap");
		expect(await failed.start("dash")).toMatchObject({
			ok: false,
			message: expect.stringContaining("firewall is failed"),
		});
		const local = make({
			firewall: { ...firewall, state: { kind: "off-local" } },
			allowNoFirewall: true,
		});
		expect(await local.start("dash")).toMatchObject({ ok: true });
	});
});
