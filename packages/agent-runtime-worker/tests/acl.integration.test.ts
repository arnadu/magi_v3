/**
 * Sprint 4 ACL integration tests.
 *
 * Verifies two denial scenarios without requiring a live LLM — tools are
 * exercised directly:
 *
 *   1. WriteFile to another agent's private dir → PolicyViolationError
 *      (checkPath runs in the child process before any filesystem access).
 *
 *   2. Bash writing to another agent's private dir → OS-level "Permission denied"
 *      (checkBashPaths was removed; the OS user boundary is the enforcement layer:
 *       magi-w1 has no write permission on magi-w2's workdir).
 *
 * Permitted-access coverage is provided by the existing Sprint 2 and Sprint 3
 * integration tests (word-count, fetch-share), which continue to pass after
 * the path layout update.
 *
 * Requires setup-dev.sh (pool users magi-w1, magi-w2 must exist).
 *
 * Run:
 *   npm run test:integration
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileTools } from "../src/tools.js";
import type {
	AgentIdentity,
	WorkspaceLayout,
} from "../src/workspace-manager.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

let testRoot: string;
let layout: WorkspaceLayout;
let wsManager: WorkspaceManager;
let allIdentities: Map<string, AgentIdentity>;

const MISSION_ID = "acl-test-mission";
const AGENT_1 = "lead";
const AGENT_2 = "worker";
const POOL_USER_1 = "magi-w1";
const POOL_USER_2 = "magi-w2";

let agent1WorkDir: string;
let agent2WorkDir: string;
let agent1PermittedPaths: string[];

beforeAll(() => {
	// Use a temp directory as the root so no root permissions are needed.
	testRoot = mkdtempSync(join(tmpdir(), "magi-acl-test-"));
	layout = {
		homeBase: join(testRoot, "home"),
		missionsBase: join(testRoot, "missions"),
	};
	wsManager = new WorkspaceManager({ layout });

	// Provision with real pool users. WorkspaceManager applies setfacl:
	//   agent1WorkDir: magi-w1 gets rwx, orchestrator gets default rwx for new files.
	//   agent2WorkDir: magi-w2 gets rwx, orchestrator gets default rwx for new files.
	// magi-w1 has NO write access to agent2WorkDir (only r-x from base mode 755).
	allIdentities = wsManager.provision(MISSION_ID, [
		{ id: AGENT_1, linuxUser: POOL_USER_1 },
		{ id: AGENT_2, linuxUser: POOL_USER_2 },
	]);

	const id1 = allIdentities.get(AGENT_1);
	const id2 = allIdentities.get(AGENT_2);
	if (!id1 || !id2) throw new Error("Test setup: identities not provisioned");
	agent1WorkDir = id1.workdir;
	agent2WorkDir = id2.workdir;
	agent1PermittedPaths = [id1.workdir, id1.sharedDir];

	// Grant pool users execute (traverse) access on testRoot so they can reach
	// their workdirs. testRoot has mode 700 from mkdtempSync; intermediate dirs
	// created by provision() have mode 755 (world-traversable by default).
	// We grant --x only (not rwx) so magi-w1 cannot write to agent2WorkDir
	// (which grants magi-w2 rwx from setfacl but only r-x for "other").
	spawnSync("setfacl", [
		"-m",
		`u:${POOL_USER_1}:--x,u:${POOL_USER_2}:--x`,
		testRoot,
	]);

	// Seed a file in agent-2's dir for the Bash denial test to target.
	writeFileSync(join(agent2WorkDir, "secret.txt"), "agent2 private data");
});

afterAll(() => {
	// Clean up temp dirs (idempotent — teardown test may have already removed some).
	rmSync(testRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTools(
	agentId: string,
	workdir: string,
	permittedPaths: string[],
	linuxUser: string,
) {
	return createFileTools(workdir, { agentId, permittedPaths, linuxUser });
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
		const tools = makeTools(
			AGENT_1,
			agent1WorkDir,
			agent1PermittedPaths,
			POOL_USER_1,
		);

		const result = await tool(tools, "WriteFile").execute("t1", {
			path: join(agent1WorkDir, "output.txt"),
			content: "hello from agent-1",
		});

		expect(result.isError).toBeFalsy();
		expect(existsSync(join(agent1WorkDir, "output.txt"))).toBe(true);
	}, 30_000);

	it("denies WriteFile to another agent's private dir", async () => {
		const tools = makeTools(
			AGENT_1,
			agent1WorkDir,
			agent1PermittedPaths,
			POOL_USER_1,
		);

		// Attempt to write to agent-2's private directory.
		// checkPath runs in the child process and rejects the path before
		// any filesystem access — PolicyViolationError is returned.
		const result = await tool(tools, "WriteFile").execute("t2", {
			path: join(agent2WorkDir, "intrusion.txt"),
			content: "agent-1 should not be here",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/PolicyViolationError/);
		// The file must NOT have been created.
		expect(existsSync(join(agent2WorkDir, "intrusion.txt"))).toBe(false);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Scenario 2 — Bash referencing another agent's private dir
// ---------------------------------------------------------------------------

describe("Bash ACL enforcement", () => {
	it("permits Bash commands within the agent's own workdir", async () => {
		const tools = makeTools(
			AGENT_1,
			agent1WorkDir,
			agent1PermittedPaths,
			POOL_USER_1,
		);

		const result = await tool(tools, "Bash").execute("t3", {
			command: `echo "hello" > "${join(agent1WorkDir, "bash-output.txt")}"`,
		});

		expect(result.isError).toBeFalsy();
		expect(existsSync(join(agent1WorkDir, "bash-output.txt"))).toBe(true);
	}, 30_000);

	it("denies Bash commands that write to another agent's private dir", async () => {
		const tools = makeTools(
			AGENT_1,
			agent1WorkDir,
			agent1PermittedPaths,
			POOL_USER_1,
		);

		// magi-w1 runs Bash via sudo. agent2WorkDir has mode 755 + setfacl magi-w2:rwx.
		// magi-w1 is not granted write access (only r-x from "other") — OS denies it.
		// No PolicyViolationError here: checkBashPaths was removed; the OS user
		// boundary is the enforcement layer.
		const result = await tool(tools, "Bash").execute("t4", {
			command: `echo "intrusion" > "${join(agent2WorkDir, "bash-intrusion.txt")}"`,
		});

		expect(result.isError).toBe(true);
		// OS-level denial message from the shell — not a PolicyViolationError.
		expect(result.content[0].text).toMatch(
			/[Pp]ermission denied|cannot create|EACCES/,
		);
		// The file must NOT have been created.
		expect(existsSync(join(agent2WorkDir, "bash-intrusion.txt"))).toBe(false);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Fixture teardown check
// ---------------------------------------------------------------------------

describe("Workspace teardown", () => {
	it("removes per-mission dirs after teardown", () => {
		wsManager.teardown(MISSION_ID, allIdentities);

		// Per-mission dirs removed.
		expect(existsSync(agent1WorkDir)).toBe(false);
		expect(existsSync(agent2WorkDir)).toBe(false);
	});
});
