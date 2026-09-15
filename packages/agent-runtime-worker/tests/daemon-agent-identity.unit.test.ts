/**
 * daemon-boot/agent-identity.ts — OS-user provisioning, the mission
 * copilot's source-access ACL grant, and the bundled provisionAgentIdentities
 * phase (Sprint 28c, issue #33). Isolated in its own test file (rather than
 * daemon-boot-phases.unit.test.ts) because it needs to mock node:child_process
 * and node:fs, which other phases' tests use for real (e.g. setupLogTee's
 * real createWriteStream/mkdirSync) — a shared file would leak these mocks
 * across describe blocks.
 */

import type { TeamConfig } from "@magi/agent-config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.fn();
vi.mock("node:child_process", () => ({
	execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

const mockExistsSync = vi.fn();
vi.mock("node:fs", () => ({
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

const {
	ensureAgentUsers,
	grantMissionCopilotSourceAccess,
	provisionAgentIdentities,
} = await import("../src/daemon-boot/agent-identity.js");

describe("ensureAgentUsers", () => {
	beforeEach(() => {
		mockExecFileSync.mockReset();
		mockExistsSync.mockReset().mockReturnValue(false);
	});

	it("does nothing for an already-existing OS user", () => {
		mockExecFileSync.mockReturnValueOnce(""); // `id <user>` succeeds
		ensureAgentUsers([{ id: "analyst" }]);
		expect(mockExecFileSync).toHaveBeenCalledTimes(1);
		expect(mockExecFileSync).toHaveBeenCalledWith("id", ["magi-w1"], {
			stdio: "ignore",
		});
	});

	it("creates the OS user via sudo magi-create-user when `id` fails", () => {
		mockExecFileSync
			.mockImplementationOnce(() => {
				throw new Error("no such user");
			})
			.mockReturnValueOnce(""); // sudo magi-create-user succeeds
		ensureAgentUsers([{ id: "analyst" }]);
		expect(mockExecFileSync).toHaveBeenCalledTimes(2);
		expect(mockExecFileSync).toHaveBeenNthCalledWith(
			2,
			"sudo",
			["/usr/local/bin/magi-create-user", "magi-w1"],
			{ stdio: "inherit" },
		);
	});

	it("does not throw when both `id` and user creation fail (non-fatal in local dev)", () => {
		mockExecFileSync.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(() => ensureAgentUsers([{ id: "analyst" }])).not.toThrow();
	});
});

describe("grantMissionCopilotSourceAccess", () => {
	beforeEach(() => {
		mockExecFileSync.mockReset();
		mockExistsSync.mockReset();
	});

	it("is a no-op when /opt/magi-src does not exist (local dev)", () => {
		mockExistsSync.mockReturnValue(false);
		grantMissionCopilotSourceAccess("magi-w1");
		expect(mockExecFileSync).not.toHaveBeenCalled();
	});

	it("grants the ACL via setfacl when the path exists", () => {
		mockExistsSync.mockReturnValue(true);
		mockExecFileSync.mockReturnValueOnce("");
		grantMissionCopilotSourceAccess("magi-w1");
		expect(mockExecFileSync).toHaveBeenCalledWith(
			"setfacl",
			["-R", "-m", "u:magi-w1:rX", "/opt/magi-src"],
			{ stdio: "ignore" },
		);
	});

	it("does not throw when setfacl fails", () => {
		mockExistsSync.mockReturnValue(true);
		mockExecFileSync.mockImplementationOnce(() => {
			throw new Error("boom");
		});
		expect(() => grantMissionCopilotSourceAccess("magi-w1")).not.toThrow();
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
		provisionAgentIdentities({ teamConfig, missionId: "m1" }, true);

		expect(teamConfig.agents.some((a) => a.id === "mission-copilot")).toBe(
			true,
		);
		// One `id` check per agent, including the just-injected copilot.
		const idCalls = mockExecFileSync.mock.calls.filter((c) => c[0] === "id");
		expect(idCalls.length).toBe(teamConfig.agents.length);
	});

	it("does not inject the mission copilot when disabled, and skips the ACL grant", () => {
		const teamConfig = baseTeamConfig();
		const originalCount = teamConfig.agents.length;
		provisionAgentIdentities({ teamConfig, missionId: "m1" }, false);

		expect(teamConfig.agents.length).toBe(originalCount);
		expect(teamConfig.agents.some((a) => a.id === "mission-copilot")).toBe(
			false,
		);
	});
});
