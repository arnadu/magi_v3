/**
 * daemon.ts::main() bootstrap phases, extracted one at a time as part of the
 * Sprint 28c decomposition (issue #33). One describe block per phase, added
 * in the same commit as that phase's extraction — not written upfront for
 * all planned phases.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatsCollector } from "../src/agent-stats.js";
import {
	SHUTDOWN_DEADLINE_MS,
	wireAbortSignal,
} from "../src/daemon-boot/abort-signal.js";
import { buildMissionCopilotTools } from "../src/daemon-boot/copilot-tools.js";
import { parseDaemonEnv } from "../src/daemon-boot/env.js";
import { startBackgroundJobs } from "../src/daemon-boot/job-runner-start.js";
import { setupLogTee } from "../src/daemon-boot/log-tee.js";
import { createMailWaiter } from "../src/daemon-boot/mail-waiter.js";
import { constructAnomalyRecorder } from "../src/daemon-boot/mission-owner.js";
import { resolveModelsAndPricing } from "../src/daemon-boot/model-pricing.js";
import { connectToMongo } from "../src/daemon-boot/mongo-connect.js";
import {
	startMonitorServer,
	startToolApiServer,
} from "../src/daemon-boot/monitor-tool-servers.js";
import {
	createOnAgentMessage,
	createRemainingOrchestrationCallbacks,
} from "../src/daemon-boot/orchestration-callbacks.js";
import { lockPidFile, pidHoldsDaemon } from "../src/daemon-boot/pid-lock.js";
import { constructRepositories } from "../src/daemon-boot/repositories.js";
import { loadDaemonTeamConfig } from "../src/daemon-boot/team-config.js";
import { syncTeamFiles } from "../src/daemon-boot/team-files-sync.js";
import { resolveUsageAndCap } from "../src/daemon-boot/usage-cap.js";
import { constructWorkspaceManager } from "../src/daemon-boot/workspace.js";
import { jobDirs } from "../src/job-runner.js";
import { CLAUDE_SONNET } from "../src/models.js";
import { UsageAccumulator } from "../src/usage.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

// connectMongo makes a real network connection — faked here so this stays a
// unit test (no network, per CLAUDE.md's Testing Approach).
const mockConnectMongo = vi.fn();
vi.mock("../src/mongo.js", () => ({
	connectMongo: (...args: unknown[]) => mockConnectMongo(...args),
	// The retry wrapper is covered by mongo-connect-retry.unit.test.ts; here it
	// is a pass-through so a failing connect surfaces immediately.
	connectWithRetry: (connect: () => Promise<unknown>) => connect(),
}));

// recoverOrphanedJobs touches the real filesystem (jobs/running,
// jobs/pending, etc.) — faked here so startBackgroundJobs's test doesn't
// need a real sharedDir with a jobs/ tree; it already has its own dedicated
// job-recovery.unit.test.ts coverage.
const mockRecoverOrphanedJobs = vi.fn(async () => {});
vi.mock("../src/job-recovery.js", () => ({
	recoverOrphanedJobs: (...args: unknown[]) => mockRecoverOrphanedJobs(...args),
}));

// loadTeamConfig reads a real YAML file from disk — faked here so the
// standalone-path branch doesn't need a fixture file; parseTeamConfig etc.
// pass through to the real implementation.
const mockLoadTeamConfig = vi.fn();
vi.mock("@magi/agent-config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@magi/agent-config")>();
	return {
		...actual,
		loadTeamConfig: (...args: unknown[]) => mockLoadTeamConfig(...args),
	};
});

/** Minimal fakeDb() extended with a stubbable findOne for the missions collection. */
function fakeDbWithMissionDoc(doc: Record<string, unknown> | null) {
	return {
		collection() {
			return {
				async createIndex() {
					return "ok";
				},
				async findOne() {
					return doc;
				},
			};
		},
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake, not a real Db
	} as any;
}

/** Matches the fakeDb() pattern in anomaly.unit.test.ts / mission-copilot-tools.unit.test.ts. */
function fakeDb() {
	return {
		collection() {
			return {
				async createIndex() {
					return "ok";
				},
			};
		},
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake, not a real Db
	} as any;
}

describe("setupLogTee", () => {
	const origStdoutWrite = process.stdout.write.bind(process.stdout);
	const origStderrWrite = process.stderr.write.bind(process.stderr);
	const origAgentWorkdir = process.env.AGENT_WORKDIR;
	let dir: string | undefined;

	afterEach(() => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		if (origAgentWorkdir === undefined) delete process.env.AGENT_WORKDIR;
		else process.env.AGENT_WORKDIR = origAgentWorkdir;
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("tees subsequent stdout/stderr writes into daemon.log under AGENT_WORKDIR", async () => {
		dir = mkdtempSync(join(tmpdir(), "magi-log-tee-"));
		process.env.AGENT_WORKDIR = dir;
		const logPath = join(dir, "daemon.log");

		const patch = setupLogTee();
		expect(patch).toEqual({});
		process.stdout.write("hello stdout\n");
		process.stderr.write("hello stderr\n");

		// createWriteStream's underlying fd opens and flushes asynchronously —
		// poll for the expected content rather than assuming the writes above
		// already landed by the time this line runs.
		const start = Date.now();
		let logged = "";
		while (!logged.includes("hello stderr")) {
			if (Date.now() - start > 2000) {
				throw new Error(`daemon.log never got expected content: ${logged}`);
			}
			if (existsSync(logPath)) logged = readFileSync(logPath, "utf8");
			await new Promise((r) => setTimeout(r, 10));
		}

		// The "[daemon] Starting up" line itself is written before the tee is
		// installed (deliberately — so it's never lost if setup itself fails),
		// so only writes issued after setupLogTee() returns land in the file.
		expect(logged).toContain("hello stdout");
		expect(logged).toContain("hello stderr");
	});
});

describe("constructRepositories", () => {
	it("builds all six repositories from db + missionId", () => {
		const db = fakeDb();
		const repos = constructRepositories({ db, missionId: "m1" });

		expect(repos.mailboxRepo).toBeDefined();
		expect(repos.conversationRepo).toBeDefined();
		expect(repos.llmCallLog).toBeDefined();
		expect(repos.statsCollector).toBeInstanceOf(StatsCollector);
		expect(repos.missionConfigRepo).toBeDefined();
		expect(repos.objectivesRepo).toBeDefined();
	});
});

describe("constructWorkspaceManager", () => {
	it("builds a WorkspaceManager from workdir/teamDir/repoRoot", () => {
		const { workspaceManager } = constructWorkspaceManager({
			workdir: "/tmp/magi-workdir-test",
			teamDir: "/tmp/magi-team-test",
			repoRoot: "/tmp/magi-repo-test",
		});
		expect(workspaceManager).toBeInstanceOf(WorkspaceManager);
	});
});

describe("resolveModelsAndPricing", () => {
	it("resolves model/visionModel ids from teamConfig, falling back to defaults", async () => {
		const teamConfig = {
			mission: { id: "m1", name: "Test" },
		} as Parameters<typeof resolveModelsAndPricing>[0]["teamConfig"];

		const result = await resolveModelsAndPricing({ teamConfig });

		expect(result.modelId).toBe("claude-sonnet-4-6");
		expect(result.model.id).toBe("claude-sonnet-4-6");
		expect(result.visionModel.id).toBe("claude-haiku-4-5-20251001");
	});

	it("prefers teamConfig.mission.model/visionModel over the built-in default", async () => {
		const teamConfig = {
			mission: {
				id: "m1",
				name: "Test",
				model: "claude-haiku-4-5-20251001",
				visionModel: "claude-sonnet-4-6",
			},
		} as Parameters<typeof resolveModelsAndPricing>[0]["teamConfig"];

		const result = await resolveModelsAndPricing({ teamConfig });

		expect(result.modelId).toBe("claude-haiku-4-5-20251001");
		expect(result.visionModel.id).toBe("claude-sonnet-4-6");
	});
});

describe("parseDaemonEnv", () => {
	const ENV_KEYS = [
		"TEAM_CONFIG",
		"MISSION_ID",
		"MONGODB_URI",
		"AGENT_WORKDIR",
		"ANTHROPIC_API_KEY",
		"BRAVE_SEARCH_API_KEY",
	] as const;
	const orig: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) orig[key] = process.env[key];
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (orig[key] === undefined) delete process.env[key];
			else process.env[key] = orig[key];
		}
	});

	it("fails when MONGODB_URI is missing", () => {
		delete process.env.MONGODB_URI;
		process.env.MISSION_ID = "m1";
		process.env.ANTHROPIC_API_KEY = "key";
		const result = parseDaemonEnv([]);
		expect(result).toEqual({
			ok: false,
			exitMessage: "Error: MONGODB_URI is required",
		});
	});

	it("fails when neither MISSION_ID nor TEAM_CONFIG is set", () => {
		process.env.MONGODB_URI = "mongodb://test";
		delete process.env.MISSION_ID;
		delete process.env.TEAM_CONFIG;
		process.env.ANTHROPIC_API_KEY = "key";
		const result = parseDaemonEnv([]);
		expect(result).toEqual({
			ok: false,
			exitMessage: "Error: MISSION_ID or TEAM_CONFIG is required",
		});
	});

	it("fails when ANTHROPIC_API_KEY is missing", () => {
		process.env.MONGODB_URI = "mongodb://test";
		process.env.MISSION_ID = "m1";
		delete process.env.ANTHROPIC_API_KEY;
		const result = parseDaemonEnv([]);
		expect(result).toEqual({
			ok: false,
			exitMessage: "Error: ANTHROPIC_API_KEY is required",
		});
	});

	it("succeeds and returns the parsed values when all required vars are set", () => {
		process.env.MONGODB_URI = "mongodb://test";
		process.env.MISSION_ID = "m1";
		process.env.ANTHROPIC_API_KEY = "key";
		process.env.AGENT_WORKDIR = "/tmp/magi-agent-workdir-test";
		const result = parseDaemonEnv([]);
		expect(result).toEqual({
			ok: true,
			teamConfigPath: undefined,
			missionIdEnv: "m1",
			mongoUri: "mongodb://test",
			agentWorkdir: "/tmp/magi-agent-workdir-test",
		});
	});
});

describe("loadDaemonTeamConfig", () => {
	const validAgent = {
		id: "lead",
		supervisor: "user",
		systemPrompt: "You are the lead.",
		initialMentalMap: "<section></section>",
	};

	it("MongoDB branch: missing structured config", async () => {
		const db = fakeDbWithMissionDoc(null);
		const result = await loadDaemonTeamConfig({
			db,
			missionIdEnv: "m1",
			teamConfigPath: undefined,
			agentWorkdir: "/tmp/magi-agent-workdir",
		});
		expect(result).toEqual({
			ok: false,
			exitMessage: "Error: no structured config stored for mission m1",
		});
	});

	it("MongoDB branch: invalid stored config", async () => {
		const db = fakeDbWithMissionDoc({
			mission: { id: "m1" /* missing required name */ },
			agents: [validAgent],
		});
		const result = await loadDaemonTeamConfig({
			db,
			missionIdEnv: "m1",
			teamConfigPath: undefined,
			agentWorkdir: "/tmp/magi-agent-workdir",
		});
		expect(result.ok).toBe(false);
		expect((result as { exitMessage: string }).exitMessage).toContain(
			"Error: stored config for mission m1 is invalid",
		);
	});

	it("MongoDB branch: valid stored config resolves teamDir under agentWorkdir/team", async () => {
		const db = fakeDbWithMissionDoc({
			mission: { id: "m1", name: "Test Mission" },
			agents: [validAgent],
		});
		const result = await loadDaemonTeamConfig({
			db,
			missionIdEnv: "m1",
			teamConfigPath: undefined,
			agentWorkdir: "/tmp/magi-agent-workdir",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok:true");
		expect(result.missionId).toBe("m1");
		expect(result.teamDir).toBe("/tmp/magi-agent-workdir/team");
		expect(result.teamConfig.mission.name).toBe("Test Mission");
	});

	it("YAML branch: derives missionId from teamConfig and teamDir from the file path", async () => {
		mockLoadTeamConfig.mockReturnValueOnce({
			mission: { id: "yaml-mission", name: "YAML Mission" },
			agents: [validAgent],
		});
		const db = fakeDbWithMissionDoc(null);
		const result = await loadDaemonTeamConfig({
			db,
			missionIdEnv: undefined,
			teamConfigPath: "/some/dir/my-team.yaml",
			agentWorkdir: "/tmp/magi-agent-workdir",
		});
		expect(mockLoadTeamConfig).toHaveBeenCalledWith("/some/dir/my-team.yaml");
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok:true");
		expect(result.missionId).toBe("yaml-mission");
		expect(result.teamDir).toBe("/some/dir/my-team");
	});
});

describe("syncTeamFiles", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("writes teamFiles from the mission doc into teamDir", async () => {
		dir = mkdtempSync(join(tmpdir(), "magi-team-files-"));
		const db = fakeDbWithMissionDoc({
			teamFiles: [
				{ path: "skills/foo.md", content: "# Foo" },
				{ path: "playbooks/bar.yaml", content: "bar: 1" },
			],
		});
		await syncTeamFiles({ db, missionId: "m1", teamDir: dir });

		expect(readFileSync(join(dir, "skills/foo.md"), "utf8")).toBe("# Foo");
		expect(readFileSync(join(dir, "playbooks/bar.yaml"), "utf8")).toBe(
			"bar: 1",
		);
	});

	it("is a no-op when the mission doc has no teamFiles", async () => {
		dir = mkdtempSync(join(tmpdir(), "magi-team-files-"));
		const db = fakeDbWithMissionDoc({});
		await syncTeamFiles({ db, missionId: "m1", teamDir: dir });
		expect(existsSync(join(dir, "skills"))).toBe(false);
	});

	it("does not throw when the Mongo read fails", async () => {
		const db = {
			collection() {
				return {
					async findOne() {
						throw new Error("boom");
					},
				};
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake, not a real Db
		} as any;
		await expect(
			syncTeamFiles({ db, missionId: "m1", teamDir: "/tmp/unused" }),
		).resolves.toEqual({});
	});

	// TF1/CHAIN-A (2026-10-15 audit): relPath is tenant/agent-authored. These
	// pin the exact attack shapes from the finding — a traversal or symlink
	// must never let a write land outside teamDir, and a bad entry must not
	// stop the rest of the (valid) files from syncing.
	it("rejects a traversal path and still writes the other valid files", async () => {
		const base = mkdtempSync(join(tmpdir(), "magi-team-files-"));
		dir = base;
		const teamDir = join(base, "team");
		mkdirSync(teamDir);
		const db = fakeDbWithMissionDoc({
			teamFiles: [
				{ path: "../outside-marker.txt", content: "evil" },
				{ path: "skills/foo.md", content: "# Foo" },
			],
		});
		await syncTeamFiles({ db, missionId: "m1", teamDir });

		expect(existsSync(join(base, "outside-marker.txt"))).toBe(false);
		expect(readFileSync(join(teamDir, "skills/foo.md"), "utf8")).toBe("# Foo");
	});

	it("rejects an absolute path", async () => {
		const base = mkdtempSync(join(tmpdir(), "magi-team-files-"));
		dir = base;
		const teamDir = join(base, "team");
		mkdirSync(teamDir);
		const absTarget = join(base, "abs-marker.txt");
		const db = fakeDbWithMissionDoc({
			teamFiles: [{ path: absTarget, content: "evil" }],
		});
		await syncTeamFiles({ db, missionId: "m1", teamDir });

		expect(existsSync(absTarget)).toBe(false);
	});

	it("rejects a write through a symlinked parent directory that resolves outside teamDir", async () => {
		const base = mkdtempSync(join(tmpdir(), "magi-team-files-"));
		dir = base;
		const teamDir = join(base, "team");
		const outsideDir = join(base, "outside");
		mkdirSync(teamDir);
		mkdirSync(outsideDir);
		symlinkSync(outsideDir, join(teamDir, "linked"));
		const db = fakeDbWithMissionDoc({
			teamFiles: [{ path: "linked/evil.txt", content: "evil" }],
		});
		await syncTeamFiles({ db, missionId: "m1", teamDir });

		expect(existsSync(join(outsideDir, "evil.txt"))).toBe(false);
	});

	it("rejects a write to a path that is itself a symlink (O_NOFOLLOW)", async () => {
		const base = mkdtempSync(join(tmpdir(), "magi-team-files-"));
		dir = base;
		const teamDir = join(base, "team");
		const outsideDir = join(base, "outside");
		mkdirSync(teamDir);
		mkdirSync(outsideDir);
		const target = join(outsideDir, "target.txt");
		writeFileSync(target, "original");
		symlinkSync(target, join(teamDir, "evil.txt"));
		const db = fakeDbWithMissionDoc({
			teamFiles: [{ path: "evil.txt", content: "evil" }],
		});
		await syncTeamFiles({ db, missionId: "m1", teamDir });

		expect(readFileSync(target, "utf8")).toBe("original");
	});
});

describe("constructAnomalyRecorder", () => {
	const teamConfigWithCopilot = {
		mission: { id: "m1", name: "Test" },
		agents: [{ id: "mission-copilot" }],
	} as Parameters<typeof constructAnomalyRecorder>[0]["teamConfig"];
	const teamConfigNoCopilot = {
		mission: { id: "m1", name: "Test" },
		agents: [{ id: "analyst" }],
	} as Parameters<typeof constructAnomalyRecorder>[0]["teamConfig"];
	const mailboxRepo = {} as Parameters<
		typeof constructAnomalyRecorder
	>[0]["mailboxRepo"];

	it("warns and builds a recorder with no control-plane relay when the mission has no userId", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const db = fakeDbWithMissionDoc({});
		try {
			const { anomalyRecorder } = await constructAnomalyRecorder(
				{ db, missionId: "m1", teamConfig: teamConfigNoCopilot, mailboxRepo },
				true,
			);
			expect(anomalyRecorder).toBeDefined();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("has no userId on its mission document"),
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("does not warn when the mission has a userId", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const db = fakeDbWithMissionDoc({ userId: "u1" });
		try {
			await constructAnomalyRecorder(
				{ db, missionId: "m1", teamConfig: teamConfigWithCopilot, mailboxRepo },
				true,
			);
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("builds without error when missionCopilotEnabled is false, even with a copilot agent present", async () => {
		const db = fakeDbWithMissionDoc({});
		const { anomalyRecorder } = await constructAnomalyRecorder(
			{ db, missionId: "m1", teamConfig: teamConfigWithCopilot, mailboxRepo },
			false,
		);
		expect(anomalyRecorder).toBeDefined();
	});
});

describe("lockPidFile", () => {
	let dir: string | undefined;
	const fakeAnomalyRecorder = { record: vi.fn(async () => {}) };

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		fakeAnomalyRecorder.record.mockClear();
	});

	it("writes the current PID when no PID file exists yet", () => {
		dir = mkdtempSync(join(tmpdir(), "magi-pid-lock-"));
		const { pidFile } = lockPidFile({
			workdir: dir,
			missionId: "m1",
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake, matches AnomalyRecorder's one used method
			anomalyRecorder: fakeAnomalyRecorder as any,
		});
		expect(readFileSync(pidFile, "utf8")).toBe(String(process.pid));
	});

	it("refuses to start (exits 1) when the PID file names a live process", () => {
		dir = mkdtempSync(join(tmpdir(), "magi-pid-lock-"));
		const missionDir = join(dir, "missions", "m1");
		mkdirSync(missionDir, { recursive: true });
		writeFileSync(join(missionDir, "daemon.pid"), "999999");

		// process.kill(pid, 0) not throwing means "process is alive" to the
		// source code. process.exit is stubbed as a no-op (not a throw) since
		// the source's try/catch here would otherwise swallow a thrown mock
		// exception as if it were process.kill's own ESRCH — a real
		// process.exit(1) never returns, so that ambiguity can't arise outside
		// a test; the meaningful assertion is just that exit(1) was reached.
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation(() => undefined as never);
		try {
			lockPidFile(
				{
					workdir: dir as string,
					missionId: "m1",
					// biome-ignore lint/suspicious/noExplicitAny: minimal fake
					anomalyRecorder: fakeAnomalyRecorder as any,
				},
				() => true,
			);
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			exitSpy.mockRestore();
		}
	});

	it("treats a PID file holding this process's own PID as an unclean restart (PID1)", () => {
		dir = mkdtempSync(join(tmpdir(), "magi-pid-lock-"));
		const missionDir = join(dir, "missions", "m1");
		mkdirSync(missionDir, { recursive: true });
		writeFileSync(join(missionDir, "daemon.pid"), String(process.pid));
		lockPidFile(
			{
				workdir: dir,
				missionId: "m1",
				// biome-ignore lint/suspicious/noExplicitAny: minimal fake
				anomalyRecorder: fakeAnomalyRecorder as any,
			},
			() => true,
		);
		expect(fakeAnomalyRecorder.record).toHaveBeenCalledWith(
			expect.objectContaining({ category: "unclean-restart" }),
		);
	});

	it("records a soft anomaly and starts fresh when the PID file is stale", () => {
		dir = mkdtempSync(join(tmpdir(), "magi-pid-lock-"));
		const missionDir = join(dir, "missions", "m1");
		mkdirSync(missionDir, { recursive: true });
		writeFileSync(join(missionDir, "daemon.pid"), "999999");

		{
			const { pidFile } = lockPidFile(
				{
					workdir: dir,
					missionId: "m1",
					// biome-ignore lint/suspicious/noExplicitAny: minimal fake
					anomalyRecorder: fakeAnomalyRecorder as any,
				},
				() => false,
			);
			expect(readFileSync(pidFile, "utf8")).toBe(String(process.pid));
			expect(fakeAnomalyRecorder.record).toHaveBeenCalledWith(
				expect.objectContaining({
					missionId: "m1",
					category: "unclean-restart",
					severity: "soft",
				}),
			);
		}
	});
});

describe("pidHoldsDaemon (PID1)", () => {
	it("is false for a dead PID", () => {
		expect(pidHoldsDaemon(2 ** 22 + 12_345)).toBe(false);
	});

	it.runIf(existsSync("/proc/self/cmdline"))(
		"on Linux, needs a live PID whose command line is the daemon's",
		() => {
			expect(pidHoldsDaemon(process.pid, () => "node\0vitest")).toBe(false);
			expect(
				pidHoldsDaemon(
					process.pid,
					() => "node\0--import\0./dist/node-polyfill.js\0dist/daemon.js",
				),
			).toBe(true);
			expect(
				pidHoldsDaemon(process.pid, () => {
					throw new Error("ENOENT");
				}),
			).toBe(false);
		},
	);
});

describe("startMonitorServer", () => {
	// Only the port-validation logic is unit-tested here: constructing a real
	// MonitorServer requires a real Mongo connection for its background
	// watchMailbox()/watchConversations() change streams (started fire-and-
	// forget inside .start()), which the existing monitor-*.integration.test.ts
	// suite and daemon-job.integration.test.ts's real end-to-end daemon boot
	// already cover — re-run after this extraction per the plan's
	// characterization-test strategy, rather than duplicated with a fake db
	// here. Neither port-validation branch reads any ctx field before
	// throwing, so an empty ctx is safe to pass.
	const origMonitorPort = process.env.MONITOR_PORT;
	const origToolPort = process.env.TOOL_PORT;

	afterEach(() => {
		if (origMonitorPort === undefined) delete process.env.MONITOR_PORT;
		else process.env.MONITOR_PORT = origMonitorPort;
		if (origToolPort === undefined) delete process.env.TOOL_PORT;
		else process.env.TOOL_PORT = origToolPort;
	});

	it("exits 1 on an invalid MONITOR_PORT", async () => {
		process.env.MONITOR_PORT = "0";
		class ExitCalled extends Error {}
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new ExitCalled();
		});
		try {
			// biome-ignore lint/suspicious/noExplicitAny: never dereferenced before the throw
			await expect(startMonitorServer({} as any)).rejects.toThrow(ExitCalled);
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			exitSpy.mockRestore();
		}
	});

	it("exits 1 on an invalid TOOL_PORT", async () => {
		delete process.env.MONITOR_PORT;
		process.env.TOOL_PORT = "-1";
		class ExitCalled extends Error {}
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new ExitCalled();
		});
		try {
			// biome-ignore lint/suspicious/noExplicitAny: never dereferenced before the throw
			await expect(startMonitorServer({} as any)).rejects.toThrow(ExitCalled);
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			exitSpy.mockRestore();
		}
	});
});

describe("startToolApiServer", () => {
	it("constructs and listens on an ephemeral port without a real Mongo connection", () => {
		const teamConfig = {
			mission: { id: "m1", name: "Test" },
			agents: [],
		} as Parameters<typeof startToolApiServer>[0]["teamConfig"];
		const mailboxRepo = {} as Parameters<
			typeof startToolApiServer
		>[0]["mailboxRepo"];

		const { toolApiServer } = startToolApiServer({
			model: CLAUDE_SONNET,
			visionModel: CLAUDE_SONNET,
			sharedDir: "/tmp/magi-tool-api-test",
			mailboxRepo,
			teamConfig,
			toolPort: 0, // OS assigns a free port
			// Charging and gating are covered in tool-api-spend.unit.test.ts.
			...({} as Omit<
				Parameters<typeof startToolApiServer>[0],
				| "model"
				| "visionModel"
				| "sharedDir"
				| "mailboxRepo"
				| "teamConfig"
				| "toolPort"
			>),
		});
		expect(toolApiServer).toBeDefined();
		toolApiServer.stop();
	});
});

describe("startBackgroundJobs", () => {
	it("recovers orphaned jobs before starting the job runner, and threads stopJobRunner through", async () => {
		mockRecoverOrphanedJobs.mockClear();
		const callOrder: string[] = [];
		mockRecoverOrphanedJobs.mockImplementationOnce(async () => {
			callOrder.push("recover");
		});
		const stopFn = vi.fn();
		const fakeStartJobRunner = vi.fn(() => {
			callOrder.push("start");
			return stopFn;
		});

		const mailboxRepo = {} as Parameters<
			typeof startBackgroundJobs
		>[0]["mailboxRepo"];
		const anomalyRecorder = {} as Parameters<
			typeof startBackgroundJobs
		>[0]["anomalyRecorder"];
		const toolApiServer = {} as Parameters<
			typeof startBackgroundJobs
		>[0]["toolApiServer"];
		const teamConfig = {} as Parameters<
			typeof startBackgroundJobs
		>[0]["teamConfig"];
		// ensureScheduleIndexes runs at boot (ADR-0033 §3); only createIndex is touched.
		const db = {
			collection: () => ({ createIndex: async () => "ok" }),
		} as unknown as Parameters<typeof startBackgroundJobs>[0]["db"];

		const { stopJobRunner } = await startBackgroundJobs(
			{
				sharedDir: "/tmp/magi-shared-test",
				workdir: "/tmp/magi-workdir-test",
				missionId: "m1",
				mailboxRepo,
				anomalyRecorder,
				toolApiServer,
				toolPort: 4001,
				teamConfig,
				db,
			},
			fakeStartJobRunner,
		);

		expect(mockRecoverOrphanedJobs).toHaveBeenCalledWith(
			jobDirs("/tmp/magi-shared-test"),
			"m1",
			mailboxRepo,
			anomalyRecorder,
		);
		expect(fakeStartJobRunner).toHaveBeenCalledWith(
			"/tmp/magi-shared-test",
			"/tmp/magi-workdir-test",
			"m1",
			toolApiServer,
			4001,
			mailboxRepo,
			teamConfig,
			db,
			anomalyRecorder,
		);
		expect(callOrder).toEqual(["recover", "start"]);
		expect(stopJobRunner).toBe(stopFn);
	});
});

describe("createMailWaiter", () => {
	function fakeChangeStream(behavior: "change" | "error" | "hang") {
		const closeFn = vi.fn(async () => {});
		return {
			close: closeFn,
			once(event: string, cb: (arg?: unknown) => void) {
				if (event === "change" && behavior === "change") {
					queueMicrotask(() => cb());
				}
				if (event === "error" && behavior === "error") {
					queueMicrotask(() => cb(new Error("stream boom")));
				}
			},
		};
	}

	it("resolves immediately without watching when the signal is already aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		const watch = vi.fn();
		const mailboxCol = { watch } as unknown as Parameters<
			typeof createMailWaiter
		>[0];
		await createMailWaiter(mailboxCol, "m1", ac.signal)();
		expect(watch).not.toHaveBeenCalled();
	});

	it("resolves and closes the stream when a change event fires", async () => {
		const ac = new AbortController();
		const stream = fakeChangeStream("change");
		const watch = vi.fn(() => stream);
		const mailboxCol = { watch } as unknown as Parameters<
			typeof createMailWaiter
		>[0];
		await createMailWaiter(mailboxCol, "m1", ac.signal)();
		expect(stream.close).toHaveBeenCalled();
	});

	it("resolves and closes the stream when aborted mid-wait", async () => {
		const ac = new AbortController();
		const stream = fakeChangeStream("hang");
		const watch = vi.fn(() => stream);
		const mailboxCol = { watch } as unknown as Parameters<
			typeof createMailWaiter
		>[0];
		const promise = createMailWaiter(mailboxCol, "m1", ac.signal)();
		ac.abort();
		await promise;
		expect(stream.close).toHaveBeenCalled();
	});

	it("retries with a new watch() after a stream error", async () => {
		vi.useFakeTimers();
		try {
			const ac = new AbortController();
			const errorStream = fakeChangeStream("error");
			const secondStream = fakeChangeStream("hang");
			const watch = vi
				.fn()
				.mockReturnValueOnce(errorStream)
				.mockReturnValueOnce(secondStream);
			const mailboxCol = { watch } as unknown as Parameters<
				typeof createMailWaiter
			>[0];

			const promise = createMailWaiter(mailboxCol, "m1", ac.signal)();
			await vi.advanceTimersByTimeAsync(1000); // the 1s initial backoff
			expect(watch).toHaveBeenCalledTimes(2);

			ac.abort();
			await promise;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("buildMissionCopilotTools", () => {
	it("returns undefined when the mission copilot is disabled", () => {
		const db = fakeDb();
		const ctx = {
			db,
			missionId: "m1",
			sharedDir: "/tmp/magi-shared-test",
			objectivesRepo: {} as Parameters<
				typeof buildMissionCopilotTools
			>[0]["objectivesRepo"],
			mailboxRepo: {} as Parameters<
				typeof buildMissionCopilotTools
			>[0]["mailboxRepo"],
			monitorPort: 4000,
		};
		const { missionCopilotTools } = buildMissionCopilotTools(
			ctx,
			false,
			() => false,
		);
		expect(missionCopilotTools).toBeUndefined();
	});

	it("returns a non-empty tool array when the mission copilot is enabled", () => {
		const db = fakeDb();
		const ctx = {
			db,
			missionId: "m1",
			sharedDir: "/tmp/magi-shared-test",
			objectivesRepo: {} as Parameters<
				typeof buildMissionCopilotTools
			>[0]["objectivesRepo"],
			mailboxRepo: {} as Parameters<
				typeof buildMissionCopilotTools
			>[0]["mailboxRepo"],
			monitorPort: 4000,
		};
		const cancelBackgroundJob = vi.fn(() => false);
		const { missionCopilotTools } = buildMissionCopilotTools(
			ctx,
			true,
			cancelBackgroundJob,
		);
		expect(missionCopilotTools?.length).toBeGreaterThan(0);
	});
});

describe("createOnAgentMessage", () => {
	function fakeUsage() {
		return {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			cost: {
				total: 0.01,
				input: 0.005,
				output: 0.005,
				cacheRead: 0,
				cacheWrite: 0,
			},
		};
	}

	function fakeAssistantMessage(opts: {
		stopReason?: string;
		errorMessage?: string;
	}): Parameters<ReturnType<typeof createOnAgentMessage>>[1] {
		return {
			role: "assistant",
			content: [],
			usage: fakeUsage(),
			stopReason: opts.stopReason ?? "end_turn",
			errorMessage: opts.errorMessage,
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake message, cast once here rather than at every call site
		} as any;
	}

	function buildCtx() {
		const monitor = { push: vi.fn(), notifyCostPause: vi.fn(async () => {}) };
		const statsCollector = {
			readMissionSnapshot: vi.fn(async () => [] as never[]),
		};
		const missionConfigRepo = {
			readTeamConfig: vi.fn(async () => null),
		};
		const anomalyRecorder = { record: vi.fn(async () => {}) };
		const mailboxRepo = { post: vi.fn(async () => ({}) as never) };
		const usageAccumulator = new UsageAccumulator();
		return {
			usageAccumulator,
			// biome-ignore lint/suspicious/noExplicitAny: minimal fakes, matching only the methods called
			monitor: monitor as any,
			// biome-ignore lint/suspicious/noExplicitAny: minimal fakes
			statsCollector: statsCollector as any,
			missionId: "m1",
			// biome-ignore lint/suspicious/noExplicitAny: minimal fakes
			missionConfigRepo: missionConfigRepo as any,
			maxCostUsd: null as number | null,
			// biome-ignore lint/suspicious/noExplicitAny: minimal fakes
			anomalyRecorder: anomalyRecorder as any,
			// biome-ignore lint/suspicious/noExplicitAny: minimal fakes
			mailboxRepo: mailboxRepo as any,
			mocks: {
				monitor,
				statsCollector,
				missionConfigRepo,
				anomalyRecorder,
				mailboxRepo,
			},
		};
	}

	it("does nothing for a non-assistant message", async () => {
		const { mocks, ...ctx } = buildCtx();
		const onAgentMessage = createOnAgentMessage(ctx);
		await onAgentMessage("analyst", {
			role: "toolResult",
			toolName: "Bash",
			isError: false,
			content: [],
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake message
		} as any);
		expect(mocks.monitor.push).not.toHaveBeenCalled();
	});

	it("tracks usage and pushes an llm-call event for an assistant message", async () => {
		const { mocks, ...ctx } = buildCtx();
		const onAgentMessage = createOnAgentMessage(ctx);
		await onAgentMessage("analyst", fakeAssistantMessage({}));
		expect(mocks.monitor.push).toHaveBeenCalledWith(
			"llm-call",
			expect.objectContaining({ agentId: "analyst", input: 100, output: 50 }),
		);
	});

	it("does not pause when under the mission cap", async () => {
		const { mocks, ...ctx } = buildCtx();
		ctx.maxCostUsd = 100;
		mocks.statsCollector.readMissionSnapshot.mockResolvedValue([
			{ lifetimeCostUsd: 1, turnCostUsd: 0 },
		]);
		const onAgentMessage = createOnAgentMessage(ctx);
		await onAgentMessage("analyst", fakeAssistantMessage({}));
		expect(mocks.monitor.notifyCostPause).not.toHaveBeenCalled();
	});

	it("pauses, records a hard anomaly, and notifies the operator when the mission cap is reached", async () => {
		const { mocks, ...ctx } = buildCtx();
		ctx.maxCostUsd = 10;
		mocks.statsCollector.readMissionSnapshot.mockResolvedValue([
			{ lifetimeCostUsd: 10, turnCostUsd: 0.5 },
		]);
		const onAgentMessage = createOnAgentMessage(ctx);
		await onAgentMessage("analyst", fakeAssistantMessage({}));
		expect(mocks.monitor.notifyCostPause).toHaveBeenCalledWith(10.5, 10);
		expect(mocks.anomalyRecorder.record).toHaveBeenCalledWith(
			expect.objectContaining({ category: "limit-breach", severity: "hard" }),
		);
		expect(mocks.mailboxRepo.post).toHaveBeenCalledWith(
			expect.objectContaining({ subject: "Mission spend cap reached" }),
		);
	});

	it("prefers the live-config cap over the boot-time fallback", async () => {
		const { mocks, ...ctx } = buildCtx();
		ctx.maxCostUsd = 1000; // boot-time fallback — should be ignored
		mocks.missionConfigRepo.readTeamConfig.mockResolvedValue({
			mission: { maxCostUsd: 5 },
		});
		mocks.statsCollector.readMissionSnapshot.mockResolvedValue([
			{ lifetimeCostUsd: 5, turnCostUsd: 0 },
		]);
		const onAgentMessage = createOnAgentMessage(ctx);
		await onAgentMessage("analyst", fakeAssistantMessage({}));
		expect(mocks.monitor.notifyCostPause).toHaveBeenCalledWith(5, 5);
	});

	it("fails open (logs, does not throw) when the cap check itself errors", async () => {
		const { mocks, ...ctx } = buildCtx();
		mocks.statsCollector.readMissionSnapshot.mockRejectedValue(
			new Error("mongo down"),
		);
		const onAgentMessage = createOnAgentMessage(ctx);
		await expect(
			onAgentMessage("analyst", fakeAssistantMessage({})),
		).resolves.toBeUndefined();
	});

	it("classifies an overloaded/rate-limit error as transient (soft anomaly)", async () => {
		const { mocks, ...ctx } = buildCtx();
		const onAgentMessage = createOnAgentMessage(ctx);
		await onAgentMessage(
			"analyst",
			fakeAssistantMessage({
				stopReason: "error",
				errorMessage: "overloaded",
			}),
		);
		expect(mocks.monitor.push).toHaveBeenCalledWith(
			"agent-error",
			expect.objectContaining({ transient: true }),
		);
		expect(mocks.anomalyRecorder.record).toHaveBeenCalledWith(
			expect.objectContaining({ category: "llm-error", severity: "soft" }),
		);
	});

	it("classifies a non-transient LLM error as hard", async () => {
		const { mocks, ...ctx } = buildCtx();
		const onAgentMessage = createOnAgentMessage(ctx);
		await onAgentMessage(
			"analyst",
			fakeAssistantMessage({
				stopReason: "error",
				errorMessage: "invalid api key",
			}),
		);
		expect(mocks.monitor.push).toHaveBeenCalledWith(
			"agent-error",
			expect.objectContaining({ transient: false }),
		);
		expect(mocks.anomalyRecorder.record).toHaveBeenCalledWith(
			expect.objectContaining({ category: "llm-error", severity: "hard" }),
		);
	});
});

describe("createRemainingOrchestrationCallbacks", () => {
	function buildCtx() {
		const monitor = {
			push: vi.fn(),
			notifyAgentStart: vi.fn(),
			setAgentWorkdirs: vi.fn(),
			notifyAgentDone: vi.fn(),
			notifyIdle: vi.fn(),
			notifyMentalMapUpdate: vi.fn(),
		};
		const anomalyRecorder = { record: vi.fn(async () => {}) };
		const mailboxRepo = { post: vi.fn(async () => ({}) as never) };
		const objectivesRepo = {};
		return {
			// biome-ignore lint/suspicious/noExplicitAny: minimal fakes, matching only the methods called
			monitor: monitor as any,
			// biome-ignore lint/suspicious/noExplicitAny: minimal fakes
			anomalyRecorder: anomalyRecorder as any,
			missionId: "m1",
			// biome-ignore lint/suspicious/noExplicitAny: minimal fakes
			mailboxRepo: mailboxRepo as any,
			sharedDir: "/tmp/magi-shared-test",
			// biome-ignore lint/suspicious/noExplicitAny: minimal fakes
			objectivesRepo: objectivesRepo as any,
			mocks: { monitor, anomalyRecorder, mailboxRepo },
		};
	}

	function fakeLimitAlert(severity: "soft" | "hard") {
		return {
			agentId: "analyst",
			turnNumber: 3,
			breach: {
				rule: {
					id: "r1",
					severity,
					metric: "costUsd",
					threshold: 5,
					label: "cost",
				},
				value: 6,
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake LimitAlert
		} as any;
	}

	it("onLimitAlert pushes a dashboard event and records the anomaly for a soft breach, without notifying the operator", () => {
		const { mocks, ...ctx } = buildCtx();
		const callbacks = createRemainingOrchestrationCallbacks(ctx, true);
		callbacks.onLimitAlert(fakeLimitAlert("soft"));
		expect(mocks.monitor.push).toHaveBeenCalledWith(
			"limit-alert",
			expect.objectContaining({ severity: "soft" }),
		);
		expect(mocks.anomalyRecorder.record).toHaveBeenCalledWith(
			expect.objectContaining({ category: "limit-breach", severity: "soft" }),
		);
		expect(mocks.mailboxRepo.post).not.toHaveBeenCalled();
	});

	it("onLimitAlert also notifies the operator directly for a hard breach", () => {
		const { mocks, ...ctx } = buildCtx();
		const callbacks = createRemainingOrchestrationCallbacks(ctx, true);
		callbacks.onLimitAlert(fakeLimitAlert("hard"));
		expect(mocks.mailboxRepo.post).toHaveBeenCalledWith(
			expect.objectContaining({ subject: 'Spend limit hit — "analyst"' }),
		);
	});

	it("onAgentError pushes a non-transient agent-error event", () => {
		const { mocks, ...ctx } = buildCtx();
		const callbacks = createRemainingOrchestrationCallbacks(ctx, true);
		callbacks.onAgentError("analyst", "boom");
		expect(mocks.monitor.push).toHaveBeenCalledWith("agent-error", {
			agentId: "analyst",
			errorMessage: "boom",
			transient: false,
		});
	});

	it("onAgentStart/onAgentDone/onIdle/onMentalMapUpdate delegate to the monitor", () => {
		const { mocks, ...ctx } = buildCtx();
		const callbacks = createRemainingOrchestrationCallbacks(ctx, true);
		callbacks.onAgentStart("analyst");
		callbacks.onAgentDone("analyst");
		callbacks.onIdle();
		callbacks.onMentalMapUpdate("analyst", "<p>hi</p>");
		expect(mocks.monitor.notifyAgentStart).toHaveBeenCalledWith("analyst");
		expect(mocks.monitor.notifyAgentDone).toHaveBeenCalledWith("analyst");
		expect(mocks.monitor.notifyIdle).toHaveBeenCalled();
		expect(mocks.monitor.notifyMentalMapUpdate).toHaveBeenCalledWith(
			"analyst",
			"<p>hi</p>",
		);
	});

	it("onWorkspaceReady registers workdirs with the monitor", () => {
		const { mocks, ...ctx } = buildCtx();
		const callbacks = createRemainingOrchestrationCallbacks(ctx, false);
		const workdirs = new Map([["analyst", "/tmp/agent-workdir"]]);
		callbacks.onWorkspaceReady(workdirs);
		expect(mocks.monitor.setAgentWorkdirs).toHaveBeenCalledWith(workdirs);
	});
});

describe("connectToMongo", () => {
	it("passes mongoUri through and returns the client/db pair", async () => {
		const fakeClient = { close: vi.fn() };
		const fakeDbInstance = { collection: vi.fn() };
		mockConnectMongo.mockResolvedValueOnce({
			client: fakeClient,
			db: fakeDbInstance,
		});

		const result = await connectToMongo({ mongoUri: "mongodb://test" });

		expect(mockConnectMongo).toHaveBeenCalledWith("mongodb://test");
		expect(result.client).toBe(fakeClient);
		expect(result.db).toBe(fakeDbInstance);
	});
});

describe("wireAbortSignal", () => {
	const EVENTS = [
		"SIGTERM",
		"SIGINT",
		"uncaughtException",
		"unhandledRejection",
	] as const;

	// process.on(...) is a permanent global registration with no return handle
	// exposed by wireAbortSignal(). vitest itself already holds an
	// unhandledRejection listener before this test file ever runs, so a
	// blanket removeAllListeners() would silently break vitest's own
	// unhandled-rejection reporting for the rest of the suite — snapshot each
	// event's pre-existing listeners and restore exactly that set instead.
	let baseline: Partial<Record<(typeof EVENTS)[number], unknown[]>>;

	beforeEach(() => {
		baseline = {};
		for (const event of EVENTS) baseline[event] = [...process.listeners(event)];
		// initiateShutdown arms a real process.exit deadline; fake timers keep
		// it from ever firing inside the test runner.
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const event of EVENTS) {
			for (const listener of process.listeners(event)) {
				if (!baseline[event]?.includes(listener)) {
					// biome-ignore lint/suspicious/noExplicitAny: EventEmitter's own listener type isn't exported per-event
					process.removeListener(event, listener as any);
				}
			}
		}
	});

	/** The listener wireAbortSignal() just added, i.e. not present in baseline. */
	function newListener(
		event: (typeof EVENTS)[number],
	): (...args: unknown[]) => void {
		const added = process
			.listeners(event)
			.find((l) => !baseline[event]?.includes(l));
		if (!added) throw new Error(`no new ${event} listener found`);
		return added as (...args: unknown[]) => void;
	}

	it("registers exactly one new listener for each of SIGTERM/SIGINT/uncaughtException/unhandledRejection", () => {
		const before = Object.fromEntries(
			EVENTS.map((e) => [e, process.listenerCount(e)]),
		);
		wireAbortSignal();
		for (const event of EVENTS) {
			expect(process.listenerCount(event)).toBe(before[event] + 1);
		}
	});

	it("issue #46: an uncaughtException triggers the same graceful shutdown as SIGTERM", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { signal } = wireAbortSignal();
			expect(signal.aborted).toBe(false);
			// Invoke the registered handler directly rather than actually
			// throwing an uncaught exception inside the test runner's own process.
			newListener("uncaughtException")(new Error("boom"));
			expect(signal.aborted).toBe(true);
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("Uncaught exception"),
			);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("issue #46: an unhandledRejection triggers the same graceful shutdown as SIGTERM", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { signal } = wireAbortSignal();
			expect(signal.aborted).toBe(false);
			newListener("unhandledRejection")(new Error("boom"));
			expect(signal.aborted).toBe(true);
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("Unhandled rejection"),
			);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("aborts the signal on the first shutdown request", () => {
		const { signal, initiateShutdown } = wireAbortSignal();
		expect(signal.aborted).toBe(false);
		initiateShutdown("test");
		expect(signal.aborted).toBe(true);
	});

	it("force-exits with code 1 when a graceful shutdown outlives its deadline (AB1)", () => {
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { initiateShutdown } = wireAbortSignal();
			initiateShutdown("test");
			vi.advanceTimersByTime(SHUTDOWN_DEADLINE_MS - 1);
			expect(exitSpy).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			exitSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("force-exits with code 1 on a second shutdown request", () => {
		class ExitCalled extends Error {}
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new ExitCalled();
		});
		try {
			const { initiateShutdown } = wireAbortSignal();
			initiateShutdown("first");
			expect(() => initiateShutdown("second")).toThrow(ExitCalled);
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			exitSpy.mockRestore();
		}
	});
});

describe("resolveUsageAndCap", () => {
	const origMaxCostUsd = process.env.MAX_COST_USD;

	afterEach(() => {
		if (origMaxCostUsd === undefined) delete process.env.MAX_COST_USD;
		else process.env.MAX_COST_USD = origMaxCostUsd;
	});

	function teamConfigWith(maxCostUsd?: number) {
		return {
			mission: { id: "m1", name: "Test", maxCostUsd },
		} as Parameters<typeof resolveUsageAndCap>[0]["teamConfig"];
	}

	it("prefers the mission config's maxCostUsd over the env var", () => {
		process.env.MAX_COST_USD = "5";
		const { maxCostUsd, usageAccumulator } = resolveUsageAndCap({
			teamConfig: teamConfigWith(42),
		});
		expect(maxCostUsd).toBe(42);
		expect(usageAccumulator).toBeInstanceOf(UsageAccumulator);
	});

	it("falls back to MAX_COST_USD when the mission has no cap configured", () => {
		process.env.MAX_COST_USD = "17.5";
		const { maxCostUsd } = resolveUsageAndCap({ teamConfig: teamConfigWith() });
		expect(maxCostUsd).toBe(17.5);
	});

	it("returns null when neither is configured", () => {
		delete process.env.MAX_COST_USD;
		const { maxCostUsd } = resolveUsageAndCap({ teamConfig: teamConfigWith() });
		expect(maxCostUsd).toBeNull();
	});

	it("exits with code 1 on a non-positive MAX_COST_USD", () => {
		process.env.MAX_COST_USD = "-3";
		class ExitCalled extends Error {}
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new ExitCalled();
		});
		try {
			expect(() =>
				resolveUsageAndCap({ teamConfig: teamConfigWith() }),
			).toThrow(ExitCalled);
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			exitSpy.mockRestore();
		}
	});
});
