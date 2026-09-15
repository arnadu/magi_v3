/**
 * daemon.ts::main() bootstrap phases, extracted one at a time as part of the
 * Sprint 28c decomposition (issue #33). One describe block per phase, added
 * in the same commit as that phase's extraction — not written upfront for
 * all planned phases.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StatsCollector } from "../src/agent-stats.js";
import { setupLogTee } from "../src/daemon-boot/log-tee.js";
import { constructRepositories } from "../src/daemon-boot/repositories.js";

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
