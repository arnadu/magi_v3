/**
 * daemon.ts::main() bootstrap phases, extracted one at a time as part of the
 * Sprint 28c decomposition (issue #33). One describe block per phase, added
 * in the same commit as that phase's extraction — not written upfront for
 * all planned phases.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatsCollector } from "../src/agent-stats.js";
import { wireAbortSignal } from "../src/daemon-boot/abort-signal.js";
import { setupLogTee } from "../src/daemon-boot/log-tee.js";
import { resolveModelsAndPricing } from "../src/daemon-boot/model-pricing.js";
import { constructRepositories } from "../src/daemon-boot/repositories.js";
import { constructWorkspaceManager } from "../src/daemon-boot/workspace.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

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
