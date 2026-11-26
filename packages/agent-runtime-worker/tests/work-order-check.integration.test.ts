/**
 * A task's check script (ADR-0038, task.done-checked) run for real: through
 * the agent's isolated shell, as its pool user, in its workdir; and stopped by
 * the turn's abort signal. Requires setup-dev.sh (pool user magi-w1).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@magi/agent-config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workOrderEnv } from "../src/agent-runner-work-orders.js";
import { runCheck, type WorkOrderEnv } from "../src/objectives/work-order.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

const POOL_USER = "magi-w1";
const AGENT = "checker";
let testRoot: string;
let workdir: string;
let env: WorkOrderEnv;

beforeAll(() => {
	testRoot = mkdtempSync(join(tmpdir(), "magi-check-test-"));
	const ws = new WorkspaceManager({
		layout: {
			homeBase: join(testRoot, "home"),
			missionsBase: join(testRoot, "missions"),
		},
	});
	const id = ws
		.provision("check-test", [{ id: AGENT, linuxUser: POOL_USER }])
		.get(AGENT);
	if (!id) throw new Error("Test setup: identity not provisioned");
	workdir = id.workdir;
	spawnSync("setfacl", ["-m", `u:${POOL_USER}:--x`, testRoot]);
	const scripts = join(id.sharedDir, "skills", "_team", "triage", "scripts");
	mkdirSync(scripts, { recursive: true });
	writeFileSync(
		join(scripts, "check.sh"),
		'test -f "$WORKDIR/$1" || { echo "missing $1"; exit 1; }\necho "found $1 as $(id -un) for $AGENT_ID"\n',
	);
	writeFileSync(join(scripts, "slow.sh"), "sleep 60\n");
	spawnSync("chmod", ["-R", "a+rX", join(id.sharedDir, "skills")]);
	env = workOrderEnv([{ id: AGENT } as AgentConfig], workdir, id.sharedDir, {
		agentId: AGENT,
		permittedPaths: [workdir, id.sharedDir],
		linuxUser: POOL_USER,
		sharedDir: id.sharedDir,
	});
});

afterAll(() => rmSync(testRoot, { recursive: true, force: true }));

describe("task.done-checked: a check script run as the agent", () => {
	it("fails until its condition holds, then passes, as the agent's own user", async () => {
		const check = { script: "triage/scripts/check.sh", args: ["done.txt"] };
		const before = await runCheck(env, check);
		expect(before.passed).toBe(false);
		expect(before.output).toContain("missing done.txt");
		writeFileSync(join(workdir, "done.txt"), "ok");
		const after = await runCheck(env, check);
		expect(after.passed).toBe(true);
		expect(after.output).toContain(
			`found done.txt as ${POOL_USER} for ${AGENT}`,
		);
	});

	it("is stopped by the turn's abort signal, and does not pass", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 1000);
		const started = Date.now();
		const r = await runCheck(
			env,
			{ script: "triage/scripts/slow.sh" },
			ac.signal,
		);
		expect(r.passed).toBe(false);
		expect(Date.now() - started).toBeLessThan(20_000);
	});
});
