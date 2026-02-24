/**
 * Sprint 4 ACL integration tests.
 *
 * Tests the PolicyViolationError enforcement layer without requiring real
 * pool users or a live LLM — the tools are exercised directly.
 *
 * Two denial scenarios (per roadmap):
 *   1. WriteFile to another agent's private dir → PolicyViolationError
 *   2. Bash referencing another agent's private dir → PolicyViolationError
 *
 * Permitted-access coverage is provided by the existing Sprint 2 and Sprint 3
 * integration tests (word-count, fetch-share), which continue to pass after
 * the path layout update.
 *
 * Run:
 *   npm run test:integration
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildAgentIdentity,
	PoolRegistry,
	type WorkspaceLayout,
} from "../src/identity.js";
import { createFileTools } from "../src/tools.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

let testRoot: string;
let layout: WorkspaceLayout;
let registry: PoolRegistry;
let wsManager: WorkspaceManager;

const MISSION_ID = "acl-test-mission";
const AGENT_1 = "lead";
const AGENT_2 = "worker";

let agent1WorkDir: string;
let agent2WorkDir: string;

beforeAll(() => {
	// Use a temp directory as the root so no root permissions are needed.
	testRoot = mkdtempSync(join(tmpdir(), "magi-acl-test-"));
	layout = {
		homeBase: join(testRoot, "home"),
		missionsBase: join(testRoot, "missions"),
		poolUsers: ["magi-w1", "magi-w2"],
	};
	registry = new PoolRegistry();
	wsManager = new WorkspaceManager({ layout, registry, skipAcl: true });

	// Provision the workspace (creates dirs, assigns pool users).
	const identities = wsManager.provision(MISSION_ID, [
		{ id: AGENT_1, role: "lead-agent" },
		{ id: AGENT_2, role: "worker-agent" },
	]);

	agent1WorkDir = identities.get(AGENT_1)?.workdir;
	agent2WorkDir = identities.get(AGENT_2)?.workdir;

	// Seed a file in agent-2's dir so EditFile has something to find.
	writeFileSync(join(agent2WorkDir, "secret.txt"), "agent2 private data");
});

afterAll(() => {
	// Clean up temp dirs.
	rmSync(testRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTools(agentId: string, workdir: string, permittedPaths: string[]) {
	return createFileTools(workdir, { agentId, permittedPaths });
}

function tool(tools: ReturnType<typeof createFileTools>, name: string) {
	const t = tools.find((t) => t.name === name);
	if (!t) throw new Error(`Tool "${name}" not found`);
	return t;
}

// ---------------------------------------------------------------------------
// Scenario 1 — WriteFile to another agent's private dir
// ---------------------------------------------------------------------------

describe("WriteFile ACL enforcement", () => {
	it("permits writes within the agent's own workdir", async () => {
		const agent1Identity = buildAgentIdentity(
			MISSION_ID,
			AGENT_1,
			"magi-w1",
			"lead-agent",
			layout,
		);
		const tools = makeTools(
			AGENT_1,
			agent1WorkDir,
			agent1Identity.permittedPaths,
		);

		const result = await tool(tools, "WriteFile").execute("t1", {
			path: join(agent1WorkDir, "output.txt"),
			content: "hello from agent-1",
		});

		expect(result.isError).toBeFalsy();
		expect(existsSync(join(agent1WorkDir, "output.txt"))).toBe(true);
	});

	it("denies WriteFile to another agent's private dir", async () => {
		const agent1Identity = buildAgentIdentity(
			MISSION_ID,
			AGENT_1,
			"magi-w1",
			"lead-agent",
			layout,
		);
		const tools = makeTools(
			AGENT_1,
			agent1WorkDir,
			agent1Identity.permittedPaths,
		);

		// Attempt to write to agent-2's private directory.
		const result = await tool(tools, "WriteFile").execute("t2", {
			path: join(agent2WorkDir, "intrusion.txt"),
			content: "agent-1 should not be here",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/PolicyViolationError/);
		// The file must NOT have been created.
		expect(existsSync(join(agent2WorkDir, "intrusion.txt"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Scenario 2 — Bash referencing another agent's private dir
// ---------------------------------------------------------------------------

describe("Bash ACL enforcement", () => {
	it("permits Bash commands within the agent's own workdir", async () => {
		const agent1Identity = buildAgentIdentity(
			MISSION_ID,
			AGENT_1,
			"magi-w1",
			"lead-agent",
			layout,
		);
		const tools = makeTools(
			AGENT_1,
			agent1WorkDir,
			agent1Identity.permittedPaths,
		);

		const result = await tool(tools, "Bash").execute("t3", {
			command: `echo "hello" > "${join(agent1WorkDir, "bash-output.txt")}"`,
		});

		expect(result.isError).toBeFalsy();
		expect(existsSync(join(agent1WorkDir, "bash-output.txt"))).toBe(true);
	});

	it("denies Bash commands referencing another agent's private dir", async () => {
		const agent1Identity = buildAgentIdentity(
			MISSION_ID,
			AGENT_1,
			"magi-w1",
			"lead-agent",
			layout,
		);
		const tools = makeTools(
			AGENT_1,
			agent1WorkDir,
			agent1Identity.permittedPaths,
		);

		// Command contains an explicit reference to agent-2's private path.
		const result = await tool(tools, "Bash").execute("t4", {
			command: `echo "intrusion" > "${join(agent2WorkDir, "bash-intrusion.txt")}"`,
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/PolicyViolationError/);
		// The file must NOT have been created.
		expect(existsSync(join(agent2WorkDir, "bash-intrusion.txt"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Fixture teardown check
// ---------------------------------------------------------------------------

describe("Workspace teardown", () => {
	it("removes per-mission dirs and releases pool slots after teardown", () => {
		// Capture assignments before teardown.
		const assignmentsBefore = registry.listAssignments(MISSION_ID);
		expect(assignmentsBefore).toHaveLength(2);

		// Build identity map for teardown.
		const identities = new Map(
			assignmentsBefore.map(({ agentId, linuxUser }) => [
				agentId,
				buildAgentIdentity(MISSION_ID, agentId, linuxUser, "agent", layout),
			]),
		);

		wsManager.teardown(MISSION_ID, identities);

		// Pool slots released.
		expect(registry.listAssignments(MISSION_ID)).toHaveLength(0);

		// Per-mission dirs removed.
		expect(existsSync(agent1WorkDir)).toBe(false);
		expect(existsSync(agent2WorkDir)).toBe(false);
	});
});
