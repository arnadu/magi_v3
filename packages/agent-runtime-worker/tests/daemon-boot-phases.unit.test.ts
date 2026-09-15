/**
 * daemon.ts::main() bootstrap phases, extracted one at a time as part of the
 * Sprint 28c decomposition (issue #33). One describe block per phase, added
 * in the same commit as that phase's extraction — not written upfront for
 * all planned phases.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatsCollector } from "../src/agent-stats.js";
import { wireAbortSignal } from "../src/daemon-boot/abort-signal.js";
import { parseDaemonEnv } from "../src/daemon-boot/env.js";
import { setupLogTee } from "../src/daemon-boot/log-tee.js";
import { resolveModelsAndPricing } from "../src/daemon-boot/model-pricing.js";
import { connectToMongo } from "../src/daemon-boot/mongo-connect.js";
import { constructRepositories } from "../src/daemon-boot/repositories.js";
import { loadDaemonTeamConfig } from "../src/daemon-boot/team-config.js";
import { resolveUsageAndCap } from "../src/daemon-boot/usage-cap.js";
import { constructWorkspaceManager } from "../src/daemon-boot/workspace.js";
import { UsageAccumulator } from "../src/usage.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

// connectMongo makes a real network connection — faked here so this stays a
// unit test (no network, per CLAUDE.md's Testing Approach).
const mockConnectMongo = vi.fn();
vi.mock("../src/mongo.js", () => ({
	connectMongo: (...args: unknown[]) => mockConnectMongo(...args),
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
	// process.on("SIGTERM"/"SIGINT", ...) is a permanent global registration
	// with no return handle exposed by wireAbortSignal() — remove everything
	// this test adds so repeated runs (and other test files sharing this
	// process) never accumulate listeners.
	afterEach(() => {
		process.removeAllListeners("SIGTERM");
		process.removeAllListeners("SIGINT");
	});

	it("registers exactly one SIGTERM and one SIGINT listener", () => {
		expect(process.listenerCount("SIGTERM")).toBe(0);
		expect(process.listenerCount("SIGINT")).toBe(0);
		wireAbortSignal();
		expect(process.listenerCount("SIGTERM")).toBe(1);
		expect(process.listenerCount("SIGINT")).toBe(1);
	});

	it("aborts the signal on the first shutdown request", () => {
		const { signal, initiateShutdown } = wireAbortSignal();
		expect(signal.aborted).toBe(false);
		initiateShutdown("test");
		expect(signal.aborted).toBe(true);
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
