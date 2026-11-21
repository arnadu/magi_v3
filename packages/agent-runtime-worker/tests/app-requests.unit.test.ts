import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MissionAppDoc } from "@magi/agent-config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AppRequestDeps,
	appDirs,
	ensureAppDirs,
	processAppRequests,
} from "../src/app-requests.js";

const UID = { analyst: 60001, writer: 60002, copilot: 60011 } as const;

describe("app requests", () => {
	let root: string;
	let shared: string;
	let owners: Map<string, number>;
	let apps: Map<string, MissionAppDoc>;
	let deps: AppRequestDeps & {
		supervisor: {
			[k in "declare" | "start" | "stop" | "remove"]: ReturnType<typeof vi.fn>;
		};
	};

	const request = (id: string, by: keyof typeof UID, body: unknown) => {
		const path = join(appDirs(shared).requests, `${id}.json`);
		writeFileSync(path, JSON.stringify(body));
		owners.set(path, UID[by]);
	};
	const answer = (id: string) =>
		JSON.parse(
			readFileSync(join(appDirs(shared).answers, `${id}.json`), "utf8"),
		);

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "app-req-"));
		shared = join(root, "shared");
		mkdirSync(join(shared, "work"), { recursive: true });
		mkdirSync(join(root, "analyst-home", "site"), { recursive: true });
		writeFileSync(join(root, "analyst-home", "dash.py"), "import gradio");
		mkdirSync(join(root, "elsewhere"));
		ensureAppDirs(shared);
		owners = new Map();
		apps = new Map();
		const ok = vi.fn(async () => ({ ok: true, message: "done" }));
		deps = {
			sharedDir: shared,
			supervisor: { declare: ok, start: ok, stop: ok, remove: ok },
			store: {
				get: async (n) => apps.get(n) ?? null,
				list: async () => [...apps.values()],
			},
			workdirOf: (id) =>
				id === "analyst" ? join(root, "analyst-home") : undefined,
			actsOnAny: new Set(["mission-copilot"]),
			notify: vi.fn(async () => {}),
			daemonUid: 999,
			uidToAgentId: new Map([
				[UID.analyst, "analyst"],
				[UID.writer, "writer"],
				[UID.copilot, "mission-copilot"],
			]),
			ownerUidOf: (p) => owners.get(p) ?? -1,
		} as typeof deps;
	});

	it("declares an app for the file's owner, with its path resolved, and answers the request", async () => {
		request("r1", "analyst", {
			action: "declare",
			name: "dash",
			kind: "gradio",
			path: join(root, "analyst-home", "dash.py"),
			description: "a dashboard",
		});
		await processAppRequests(deps);
		expect(deps.supervisor.declare).toHaveBeenCalledWith({
			name: "dash",
			owner: "analyst",
			kind: "gradio",
			path: join(root, "analyst-home", "dash.py"),
			handlers: undefined,
			description: "a dashboard",
		});
		expect(answer("r1")).toMatchObject({
			requestId: "r1",
			by: "analyst",
			ok: true,
		});
		expect(existsSync(join(appDirs(shared).requests, "r1.json"))).toBe(false);
	});

	it.each([
		[
			"a path outside the owner's workdir and shared/",
			{ kind: "site", path: "elsewhere" },
			/path must be/,
		],
		[
			"another agent's workdir",
			{ kind: "site", path: "analyst-home/site", by: "writer" },
			/path must be/,
		],
		[
			"a folder for gradio",
			{ kind: "gradio", path: "analyst-home/site" },
			/\.py file/,
		],
		[
			"a file for a site",
			{ kind: "site", path: "analyst-home/dash.py" },
			/is a folder/,
		],
		[
			"an unknown kind",
			{ kind: "streamlit", path: "shared/work" },
			/kind must be/,
		],
		[
			"handlers for a notebook",
			{
				kind: "jupyter",
				path: "shared/work",
				handlers: "analyst-home/dash.py",
			},
			/site only/,
		],
	])("refuses %s", async (_what, r, message) => {
		const by = ("by" in r ? r.by : "analyst") as keyof typeof UID;
		request("r2", by, {
			action: "declare",
			name: "x",
			kind: r.kind,
			path: join(root, r.path),
			...("handlers" in r
				? { handlers: join(root, r.handlers as string) }
				: {}),
		});
		await processAppRequests(deps);
		expect(answer("r2")).toMatchObject({
			ok: false,
			message: expect.stringMatching(message),
		});
		expect(deps.supervisor.declare).not.toHaveBeenCalled();
	});

	it("refuses a bad name, a bad action, and a request no agent wrote", async () => {
		request("r3", "analyst", { action: "declare", name: "Bad Name" });
		request("r4", "analyst", { action: "restart", name: "dash" });
		const planted = join(appDirs(shared).requests, "r5.json");
		writeFileSync(planted, JSON.stringify({ action: "stop", name: "dash" }));
		owners.set(planted, 999);
		await processAppRequests(deps);
		expect(answer("r3").message).toMatch(/name must be/);
		expect(answer("r4").message).toMatch(/action must be/);
		expect(answer("r5").message).toMatch(/owned by the daemon/);
	});

	it("lets the owner and the mission copilot stop an app, not another agent; tells the owner", async () => {
		apps.set("dash", {
			name: "dash",
			owner: "analyst",
			restarts: [],
		} as unknown as MissionAppDoc);
		request("r6", "writer", { action: "stop", name: "dash" });
		request("r7", "copilot", { action: "stop", name: "dash" });
		await processAppRequests(deps);
		expect(answer("r6")).toMatchObject({
			ok: false,
			message: "app dash belongs to analyst",
		});
		expect(answer("r7")).toMatchObject({ ok: true });
		expect(deps.supervisor.stop).toHaveBeenCalledTimes(1);
		expect(deps.notify).toHaveBeenCalledWith(
			"analyst",
			"App dash stopped",
			"mission-copilot stopped your app dash.",
		);
	});

	it("writes each app's status without its capability or slot, and removes stale ones", async () => {
		apps.set("dash", {
			name: "dash",
			owner: "analyst",
			kind: "gradio",
			status: "running",
			capability: "0123456789abcdef",
			slot: 20003,
			restarts: [],
		} as unknown as MissionAppDoc);
		writeFileSync(join(appDirs(shared).status, "gone.json"), "{}");
		await processAppRequests(deps);
		const text = readFileSync(
			join(appDirs(shared).status, "dash.json"),
			"utf8",
		);
		expect(JSON.parse(text)).toMatchObject({ name: "dash", status: "running" });
		expect(text).not.toContain("0123456789abcdef");
		expect(text).not.toContain("20003");
		expect(existsSync(join(appDirs(shared).status, "gone.json"))).toBe(false);
	});
});
