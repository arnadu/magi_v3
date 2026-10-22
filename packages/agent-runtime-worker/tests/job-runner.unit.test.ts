/**
 * job-runner.ts — who a background job runs as is decided by who owns the
 * spec file, never by the spec (JOB1/JOB2, audit 2026-10). Real tmpdir;
 * spawn, file ownership and the Tool API server are injected.
 */

import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TeamConfig } from "@magi/agent-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobSpec } from "../src/job-recovery.js";
import {
	cancelBackgroundJob,
	enqueuePrivateJob,
	type JobRunnerDeps,
	jobDirs,
	runPendingJobs,
} from "../src/job-runner.js";

let base: string;
let sharedDir: string;
let workdir: string;
const MISSION = "m1";
const UID_A1 = 1001;
const UID_A2 = 1002;
const DAEMON_UID = 999;

function fakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		pid?: number;
		stdout: null;
		stderr: null;
		kill: () => void;
	};
	child.pid = 4242;
	child.stdout = null;
	child.stderr = null;
	child.kill = () => {};
	return child;
}

function deps(over: Partial<JobRunnerDeps> = {}): JobRunnerDeps & {
	spawned: string[][];
	rejected: string[];
	tokens: { issued: number; revoked: number };
	mail: { to: string[]; subject: string }[];
	children: ReturnType<typeof fakeChild>[];
} {
	const spawned: string[][] = [];
	const rejected: string[] = [];
	const tokens = { issued: 0, revoked: 0 };
	const mail: { to: string[]; subject: string }[] = [];
	const children: ReturnType<typeof fakeChild>[] = [];
	const owners = new Map<string, number>();
	const teamConfig = {
		agents: [
			{ id: "a1", linuxUser: "magi-w1" },
			{ id: "a2", linuxUser: "magi-w2" },
		],
	} as unknown as TeamConfig;
	return {
		sharedDir,
		workdir,
		missionId: MISSION,
		teamConfig,
		toolApiServer: {
			issueToken: () => {
				tokens.issued++;
				return "tok";
			},
			revokeToken: () => {
				tokens.revoked++;
			},
		} as unknown as JobRunnerDeps["toolApiServer"],
		toolPort: 4001,
		mailboxRepo: {
			post: async (m: { to: string[]; subject: string }) => {
				mail.push(m);
			},
		} as unknown as JobRunnerDeps["mailboxRepo"],
		missionCopilotEnabled: false,
		uidToAgentId: new Map([
			[UID_A1, "a1"],
			[UID_A2, "a2"],
		]),
		daemonUid: DAEMON_UID,
		spawnFn: ((cmd: string, args: string[]) => {
			spawned.push([cmd, ...args]);
			const c = fakeChild();
			children.push(c);
			return c;
		}) as unknown as JobRunnerDeps["spawnFn"],
		ownerUidOf: (p) => owners.get(p) ?? -1,
		onRejected: (_f, reason) => rejected.push(reason),
		...over,
		// test helpers
		spawned,
		rejected,
		tokens,
		mail,
		children,
		// biome-ignore lint/suspicious/noExplicitAny: test-only attachment
		...({ owners } as any),
	};
}

function pending(
	d: ReturnType<typeof deps>,
	spec: JobSpec,
	ownerUid: number,
	name = `${spec.id}.json`,
) {
	const dirs = jobDirs(sharedDir);
	mkdirSync(dirs.pending, { recursive: true });
	const p = join(dirs.pending, name);
	writeFileSync(p, JSON.stringify(spec));
	// biome-ignore lint/suspicious/noExplicitAny: test-only attachment
	(d as any).owners.set(p, ownerUid);
	return p;
}

function script(name = "run.sh"): string {
	const p = join(sharedDir, name);
	writeFileSync(p, "#!/usr/bin/env bash\necho hi\n");
	return p;
}

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "job-runner-")));
	workdir = join(base, "workdir");
	sharedDir = join(workdir, "missions", MISSION, "shared");
	mkdirSync(sharedDir, { recursive: true });
	vi.restoreAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

const spec = (over: Partial<JobSpec> = {}): JobSpec => ({
	id: "job-1",
	agentId: "a1",
	scriptPath: "",
	args: ["x"],
	...over,
});

describe("runPendingJobs — agent-submitted specs", () => {
	it("runs a spec as the agent that owns the file, with a token issued only then", async () => {
		const d = deps();
		pending(d, spec({ scriptPath: script() }), UID_A1);
		await runPendingJobs(d);
		expect(d.rejected).toEqual([]);
		expect(d.spawned).toHaveLength(1);
		expect(d.spawned[0].slice(0, 3)).toEqual(["sudo", "-u", "magi-w1"]);
		expect(d.tokens).toEqual({ issued: 1, revoked: 0 });
		expect(readdirSync(jobDirs(sharedDir).pending)).toEqual([]);
		expect(readdirSync(jobDirs(sharedDir).running)).toEqual(["job-1.json"]);
	});

	it("refuses a spec whose agentId is not the file's owner — it would run as the other agent", async () => {
		const d = deps();
		pending(d, spec({ scriptPath: script(), agentId: "a2" }), UID_A1);
		await runPendingJobs(d);
		expect(d.spawned).toEqual([]);
		expect(d.tokens.issued).toBe(0);
		expect(d.rejected[0]).toMatch(/owned by "a1"/);
		expect(readdirSync(jobDirs(sharedDir).pending)).toEqual([]);
	});

	it("refuses a daemon-owned file (renamed into pending), an unknown owner, a symlink and a hard-link count > 1", async () => {
		const d = deps();
		pending(d, spec({ id: "by-daemon", scriptPath: script() }), DAEMON_UID);
		pending(d, spec({ id: "stranger", scriptPath: script() }), 31337);
		const dirs = jobDirs(sharedDir);
		writeFileSync(
			join(sharedDir, "elsewhere.json"),
			JSON.stringify(spec({ id: "linked" })),
		);
		symlinkSync(
			join(sharedDir, "elsewhere.json"),
			join(dirs.pending, "linked.json"),
		);
		await runPendingJobs(d);
		expect(d.spawned).toEqual([]);
		expect(d.rejected.join("\n")).toMatch(/owned by the daemon/);
		expect(d.rejected.join("\n")).toMatch(/not an agent of this mission/);
		expect(d.rejected.join("\n")).toMatch(/symlink/);
		expect(readdirSync(dirs.pending)).toEqual([]);
	});

	it("refuses a file whose name is not the spec id, or not a slug", async () => {
		const d = deps();
		pending(
			d,
			spec({ id: "job-1", scriptPath: script() }),
			UID_A1,
			"other.json",
		);
		pending(d, spec({ id: "job-2", scriptPath: script() }), UID_A1, "..json");
		await runPendingJobs(d);
		expect(d.spawned).toEqual([]);
		expect(d.rejected.join("\n")).toMatch(/does not match the file name/);
		expect(d.rejected.join("\n")).toMatch(/not a job id/);
	});

	it("refuses a script outside the agent's permitted trees", async () => {
		const d = deps();
		writeFileSync(join(base, "evil.sh"), "#!/bin/sh\n");
		pending(d, spec({ scriptPath: join(base, "evil.sh") }), UID_A1);
		await runPendingJobs(d);
		expect(d.spawned).toEqual([]);
		expect(d.tokens.issued).toBe(0);
		expect(readdirSync(jobDirs(sharedDir).running)).toEqual([]);
	});

	it("on exit: revokes the token, writes the private status and the shared mirror, and notifies", async () => {
		const d = deps();
		pending(d, spec({ scriptPath: script(), notifyAgentId: "a1" }), UID_A1);
		await runPendingJobs(d);
		d.children[0].emit("close", 3);
		await new Promise((r) => setTimeout(r, 10));
		const dirs = jobDirs(sharedDir);
		expect(d.tokens).toEqual({ issued: 1, revoked: 1 });
		expect(readdirSync(dirs.running)).toEqual([]);
		const priv = JSON.parse(
			readFileSync(join(dirs.status, "job-1.json"), "utf8"),
		);
		const mirror = JSON.parse(
			readFileSync(join(dirs.statusMirror, "job-1.json"), "utf8"),
		);
		expect(priv).toMatchObject({
			id: "job-1",
			agentId: "a1",
			exitCode: 3,
			args: ["x"],
		});
		expect(mirror).toEqual(priv);
		expect(d.mail.map((m) => m.to)).toEqual([["a1"]]);
	});
});

describe("runPendingJobs — daemon-authored queue", () => {
	it("runs a private-queue spec without ownership attribution (the daemon wrote it)", async () => {
		const d = deps();
		const dirs = jobDirs(sharedDir);
		enqueuePrivateJob(
			dirs,
			spec({ id: "retry-1", agentId: "a2", scriptPath: script() }),
		);
		expect(existsSync(join(dirs.queue, "retry-1.json"))).toBe(true);
		await runPendingJobs(d);
		expect(d.spawned).toHaveLength(1);
		expect(d.spawned[0].slice(0, 3)).toEqual(["sudo", "-u", "magi-w2"]);
		expect(readdirSync(dirs.queue)).toEqual([]);
	});

	it("enqueuePrivateJob refuses a non-slug id and a duplicate", () => {
		const dirs = jobDirs(sharedDir);
		expect(() => enqueuePrivateJob(dirs, spec({ id: "../x" }))).toThrow(
			/Invalid job id/,
		);
		enqueuePrivateJob(dirs, spec({ id: "dup" }));
		expect(() => enqueuePrivateJob(dirs, spec({ id: "dup" }))).toThrow(
			/EEXIST/,
		);
	});
});

describe("runPendingJobs — killing and logging", () => {
	it("spawns the job detached and kills its group as the agent on timeout and on cancel", async () => {
		const kills: [number, string][] = [];
		let opts: { detached?: boolean } | undefined;
		const inner = deps();
		const d = deps({
			killGroupFn: (pgid, user) => {
				kills.push([pgid, user]);
				return true;
			},
			spawnFn: ((cmd: string, args: string[], o: { detached?: boolean }) => {
				opts = o;
				// biome-ignore lint/suspicious/noExplicitAny: forwarding to the default fake
				return (inner.spawnFn as any)(cmd, args);
			}) as unknown as JobRunnerDeps["spawnFn"],
		});
		pending(d, spec({ scriptPath: script(), timeoutMs: 20 }), UID_A1);
		await runPendingJobs(d);
		expect(opts?.detached).toBe(true);
		await vi.waitFor(() => expect(kills).toEqual([[4242, "magi-w1"]]));
		expect(cancelBackgroundJob("job-1")).toBe(true);
		expect(kills).toHaveLength(2);
		inner.children[0].emit("close", null);
		expect(cancelBackgroundJob("job-1")).toBe(false);
	});

	it("refuses to start a job whose log name is a planted symlink, leaving the target untouched", async () => {
		const d = deps();
		const target = join(base, "daemon-owned.conf");
		writeFileSync(target, "original\n");
		mkdirSync(join(sharedDir, "logs"), { recursive: true });
		symlinkSync(target, join(sharedDir, "logs", "bg-job-1.log"));
		pending(d, spec({ scriptPath: script() }), UID_A1);
		await runPendingJobs(d);
		expect(d.spawned).toEqual([]);
		expect(d.tokens.issued).toBe(0);
		expect(readFileSync(target, "utf8")).toBe("original\n");
	});
});
