/**
 * daemon-boot/agent-identity.ts — OS-user provisioning, the mission
 * copilot's source-access check, and the bundled provisionAgentIdentities
 * phase (Sprint 28c, issue #33). Isolated in its own test file (rather than
 * daemon-boot-phases.unit.test.ts) because it needs to mock node:child_process
 * and node:fs, which other phases' tests use for real (e.g. setupLogTee's
 * real createWriteStream/mkdirSync) — a shared file would leak these mocks
 * across describe blocks.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TeamConfig } from "@magi/agent-config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.fn();
vi.mock("node:child_process", () => ({
	execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

const mockExistsSync = vi.fn();
// Only existsSync is stubbed; the rest stays real (the mission copilot's
// prompt is read from disk when it is injected).
vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

const { existsSync } =
	await vi.importActual<typeof import("node:fs")>("node:fs");
const { readUidMap, UID_MAP_FILE, writeUidMap } = await import(
	"../src/daemon-boot/uid-map.js"
);
const {
	ensureAgentUsers,
	provisionAgentIdentities,
	verifyMissionCopilotSourceAccess,
} = await import("../src/daemon-boot/agent-identity.js");

/** execFileSync stand-in: `id -u` answers from `uids`. */
function fakeAccounts(uids: Record<string, number>) {
	mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
		if (cmd === "id") {
			const uid = uids[args[args.length - 1]];
			if (uid === undefined) throw new Error("no such user");
			return `${uid}\n`;
		}
		return "";
	});
}

function created(): Array<[string, string]> {
	return mockExecFileSync.mock.calls
		.filter((c) => c[0] === "sudo")
		.map((c) => [c[1][1], c[1][2]]);
}

describe("ensureAgentUsers", () => {
	let workdir: string;
	beforeEach(() => {
		mockExecFileSync.mockReset();
		mockExistsSync.mockReset().mockReturnValue(false);
		workdir = mkdtempSync(join(tmpdir(), "uid-map-"));
	});

	it("local dev: checks the pool users and never creates one", () => {
		fakeAccounts({ "magi-w1": 60001 });
		ensureAgentUsers([{ id: "analyst" }], workdir);
		expect(created()).toEqual([]);
		expect(existsSync(join(workdir, UID_MAP_FILE))).toBe(false);
	});

	it("does not throw when a pool user is missing (reported, not fatal, in local dev)", () => {
		fakeAccounts({});
		expect(() => ensureAgentUsers([{ id: "analyst" }], workdir)).not.toThrow();
	});

	it("production: creates each user with a pinned uid and records the map first", () => {
		mockExistsSync.mockReturnValue(true);
		fakeAccounts({ "mission-copilot": 60011 });
		ensureAgentUsers(
			[{ id: "documenter" }, { id: "appsec" }, { id: "mission-copilot" }],
			workdir,
			(uid) => uid === 1002,
		);
		expect(created()).toEqual([
			["documenter", "1001"],
			["appsec", "1003"],
		]);
		expect(readUidMap(workdir)).toEqual({
			documenter: 1001,
			appsec: 1003,
			"mission-copilot": 60011,
		});
	});

	it("production: a reordered or grown roster keeps every agent's uid", () => {
		mockExistsSync.mockReturnValue(true);
		writeUidMap(workdir, { documenter: 1003, "qa-lead": 1004 });
		fakeAccounts({});
		ensureAgentUsers(
			[{ id: "appsec" }, { id: "qa-lead" }, { id: "documenter" }],
			workdir,
			() => false,
		);
		expect(created()).toEqual([
			["appsec", "1005"],
			["qa-lead", "1004"],
			["documenter", "1003"],
		]);
	});

	it("production: refuses a user that exists under another uid than its pinned one", () => {
		mockExistsSync.mockReturnValue(true);
		writeUidMap(workdir, { documenter: 1003 });
		fakeAccounts({ documenter: 1004 });
		expect(() => ensureAgentUsers([{ id: "documenter" }], workdir)).toThrow(
			/documenter: 1004, pinned 1003/,
		);
		expect(created()).toEqual([]);
	});
});

describe("verifyMissionCopilotSourceAccess", () => {
	beforeEach(() => {
		mockExecFileSync.mockReset();
		mockExistsSync.mockReset();
	});

	it("is a no-op when /opt/magi-src does not exist (local dev)", () => {
		mockExistsSync.mockReturnValue(false);
		expect(verifyMissionCopilotSourceAccess("magi-w1")).toBe(true);
		expect(mockExecFileSync).not.toHaveBeenCalled();
	});

	it("probes readability as the copilot's own OS user through the sudo path its tools use, never with setfacl", () => {
		mockExistsSync.mockReturnValue(true);
		mockExecFileSync.mockReturnValueOnce("");
		expect(verifyMissionCopilotSourceAccess("mission-copilot")).toBe(true);
		const [cmd, args] = mockExecFileSync.mock.calls[0];
		expect([cmd, ...args.slice(0, 4)]).toEqual([
			"sudo",
			"-n",
			"-u",
			"mission-copilot",
			"/usr/local/bin/magi-node",
		]);
		expect(args.join(" ")).toContain("/opt/magi-src/MAGI_V3_SPEC.md");
		expect(mockExecFileSync.mock.calls.some((c) => c[0] === "setfacl")).toBe(
			false,
		);
	});

	it("reports false without throwing when the probe fails", () => {
		mockExistsSync.mockReturnValue(true);
		mockExecFileSync.mockImplementationOnce(() => {
			throw new Error("EACCES");
		});
		expect(verifyMissionCopilotSourceAccess("mission-copilot")).toBe(false);
	});
});

describe("provisionAgentIdentities", () => {
	beforeEach(() => {
		mockExecFileSync.mockReset().mockReturnValue("");
		mockExistsSync.mockReset().mockReturnValue(false);
	});

	function baseTeamConfig(): TeamConfig {
		return {
			mission: { id: "m1", name: "Test" },
			agents: [
				{
					id: "analyst",
					name: "analyst",
					role: "analyst",
					supervisor: "user",
					systemPrompt: "test",
					initialMentalMap: "<x></x>",
				},
			],
		} as TeamConfig;
	}

	it("injects the mission copilot and ensures OS users for the full roster when enabled", () => {
		const teamConfig = baseTeamConfig();
		provisionAgentIdentities(
			{ teamConfig, missionId: "m1", workdir: tmpdir() },
			true,
		);

		expect(teamConfig.agents.some((a) => a.id === "mission-copilot")).toBe(
			true,
		);
		// One `id` check per agent, including the just-injected copilot.
		const idCalls = mockExecFileSync.mock.calls.filter((c) => c[0] === "id");
		expect(idCalls.length).toBe(teamConfig.agents.length);
	});

	it("does not inject the mission copilot when disabled, and skips the source-access check", () => {
		const teamConfig = baseTeamConfig();
		const originalCount = teamConfig.agents.length;
		provisionAgentIdentities(
			{ teamConfig, missionId: "m1", workdir: tmpdir() },
			false,
		);

		expect(teamConfig.agents.length).toBe(originalCount);
		expect(teamConfig.agents.some((a) => a.id === "mission-copilot")).toBe(
			false,
		);
	});
});
