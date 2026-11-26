/**
 * Tasks as work orders (ADR-0038): required skills, check scripts, guarded
 * terms, the skill handover on start, and completion against the finish line.
 * The shell that runs checks is a stub; the skill tiers are real directories.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	operatorSkills,
	resolveCheckScript,
} from "../src/agent-runner-work-orders.js";
import { renderMyObjectives } from "../src/objectives/agent-view.js";
import type { ObjectivesRepository } from "../src/objectives/repository.js";
import { createObjectivesTools } from "../src/objectives/tools.js";
import type { WorkOrderEnv } from "../src/objectives/work-order.js";
import type { ToolResult } from "../src/tools.js";
import { createFakeObjectivesRepository } from "./fake-objectives-repository.js";

const missionId = "m1";

function skill(dir: string, name: string, body = `# ${name}\n`): void {
	mkdirSync(join(dir, name, "scripts"), { recursive: true });
	writeFileSync(
		join(dir, name, "SKILL.md"),
		`---\nname: ${name}\ndescription: the ${name} skill\n---\n\n${body}`,
	);
}

let sharedDir: string;
let ran: string[];
let checkResult: ToolResult;

function env(): WorkOrderEnv {
	return {
		operatorSkills: () => operatorSkills(sharedDir),
		disabledSkillsFor: (id) =>
			id === "bob" ? ["triage"] : id === "alice" ? [] : null,
		resolveCheckScript: (script) => resolveCheckScript(sharedDir, script),
		runAsCaller: async (command) => {
			ran.push(command);
			return {
				ok: !checkResult.isError,
				output: checkResult.content.map((c) => c.text).join(""),
			};
		},
	};
}

function tools(repo: ObjectivesRepository, agentId: string) {
	const ts = createObjectivesTools(repo, missionId, agentId, env());
	const get = (name: string) => {
		const t = ts.find((x) => x.name === name);
		if (!t) throw new Error(name);
		return t;
	};
	return { add: get("AddTask"), update: get("UpdateTask") };
}

const text = (r: ToolResult) => r.content.map((c) => c.text).join("");

beforeEach(() => {
	sharedDir = mkdtempSync(join(tmpdir(), "work-order-"));
	const team = join(sharedDir, "skills", "_team");
	skill(team, "triage", "Verify every finding by reading the code.");
	writeFileSync(join(team, "triage", "scripts", "check.sh"), "exit 0\n");
	skill(join(sharedDir, "skills", "_platform"), "objectives");
	skill(join(sharedDir, "skills", "mission"), "homemade");
	ran = [];
	checkResult = { content: [{ type: "text", text: "all 3 runs read" }] };
});

afterEach(() => rmSync(sharedDir, { recursive: true, force: true }));

describe("task.terms-guarded: what a work order may require, and who sets it", () => {
	it("records instructions, finish line, check and skills, and folds them", async () => {
		const repo = createFakeObjectivesRepository();
		const { add } = tools(repo, "user");
		const r = await add.execute("c", {
			id: "T-1",
			title: "First pass",
			assignee: "alice",
			instructions: "Work through the backlog.",
			doneWhen: "No item deferred.",
			check: { script: "triage/scripts/check.sh", args: ["x y"] },
			skills: ["triage", "objectives"],
		});
		expect(r.isError).toBeFalsy();
		const t = (await repo.readTree(missionId)).tasks[0];
		expect(t).toMatchObject({
			instructions: "Work through the backlog.",
			doneWhen: "No item deferred.",
			check: { script: "triage/scripts/check.sh", args: ["x y"] },
			skills: ["triage", "objectives"],
		});
	});

	it("refuses a skill that is not a team or platform skill", async () => {
		const { add } = tools(createFakeObjectivesRepository(), "user");
		for (const name of ["nope", "homemade"]) {
			const r = await add.execute("c", {
				title: "t",
				assignee: "alice",
				skills: [name],
			});
			expect(r.isError).toBe(true);
			expect(text(r)).toContain(name);
		}
	});

	it("refuses a skill the assignee has disabled, or an assignee outside the team", async () => {
		const { add } = tools(createFakeObjectivesRepository(), "user");
		const disabled = await add.execute("c", {
			title: "t",
			assignee: "bob",
			skills: ["triage"],
		});
		expect(text(disabled)).toContain("disabled for bob");
		const stranger = await add.execute("c", {
			title: "t",
			assignee: "carol",
			skills: ["triage"],
		});
		expect(text(stranger)).toContain("not an agent of this mission");
	});

	it("refuses a check script outside the read-only tiers", async () => {
		const { add } = tools(createFakeObjectivesRepository(), "user");
		symlinkSync(
			"/etc/passwd",
			join(sharedDir, "skills", "_team", "triage", "scripts", "out.sh"),
		);
		for (const script of [
			"triage/../../mission/homemade/SKILL.md",
			"homemade/SKILL.md",
			"triage/scripts/missing.sh",
			"triage/scripts/out.sh",
			"/etc/passwd",
		]) {
			const r = await add.execute("c", {
				title: "t",
				assignee: "alice",
				check: { script },
			});
			expect(r.isError, script).toBe(true);
		}
	});

	it("keeps the terms with whoever set them", async () => {
		const repo = createFakeObjectivesRepository();
		await tools(repo, "user").add.execute("c", {
			id: "T-1",
			title: "t",
			assignee: "alice",
			doneWhen: "No item deferred.",
		});
		const { update } = tools(repo, "alice");
		const r = await update.execute("c", { id: "T-1", doneWhen: "Whenever." });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("doneWhen");
		const ok = await update.execute("c", {
			id: "T-1",
			instructions: "My plan.",
		});
		expect(ok.isError).toBeFalsy();
	});
});

describe("task.done-checked: starting and completing a work order", () => {
	async function assigned(fields: Record<string, unknown>) {
		const repo = createFakeObjectivesRepository();
		await tools(repo, "user").add.execute("c", {
			id: "T-1",
			title: "t",
			assignee: "alice",
			...fields,
		});
		return repo;
	}

	it("hands over the required skills' text when the task is started, once", async () => {
		const repo = await assigned({ skills: ["triage"] });
		const { update } = tools(repo, "alice");
		const start = await update.execute("c", {
			id: "T-1",
			status: "in-progress",
		});
		expect(text(start)).toContain("Verify every finding by reading the code.");
		const again = await update.execute("c", {
			id: "T-1",
			status: "in-progress",
		});
		expect(text(again)).not.toContain("Verify every finding");
	});

	it("completes a task whose check passes, recording its output", async () => {
		const repo = await assigned({
			check: { script: "triage/scripts/check.sh", args: ["it's"] },
		});
		const r = await tools(repo, "alice").update.execute("c", {
			id: "T-1",
			status: "completed",
		});
		expect(r.isError).toBeFalsy();
		expect(ran[0]).toMatch(
			/^'bash' '.*\/_team\/triage\/scripts\/check\.sh' 'it'\\''s'$/,
		);
		const t = (await repo.readTree(missionId)).tasks[0];
		expect(t?.status).toBe("completed");
		expect(t?.notes.at(-1)).toContain("all 3 runs read");
	});

	it("refuses completion while the check fails, leaving the task as it was", async () => {
		const repo = await assigned({
			check: { script: "triage/scripts/check.sh" },
		});
		checkResult = {
			content: [{ type: "text", text: "2 items deferred" }],
			isError: true,
		};
		const r = await tools(repo, "alice").update.execute("c", {
			id: "T-1",
			status: "completed",
		});
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("2 items deferred");
		expect((await repo.readTree(missionId)).tasks[0]?.status).toBe("open");
	});

	it("needs a note meeting the finish line when there is no check", async () => {
		const repo = await assigned({ doneWhen: "No item deferred." });
		const { update } = tools(repo, "alice");
		const bare = await update.execute("c", { id: "T-1", status: "completed" });
		expect(bare.isError).toBe(true);
		const noted = await update.execute("c", {
			id: "T-1",
			status: "completed",
			note: "Run 20261127 has no deferred item (review/state/runs/20261127/summary.json).",
		});
		expect(noted.isError).toBeFalsy();
	});

	it("lets only the operator or the mission copilot override the finish line", async () => {
		const repo = await assigned({
			check: { script: "triage/scripts/check.sh" },
		});
		checkResult = { content: [{ type: "text", text: "no" }], isError: true };
		const byAgent = await tools(repo, "alice").update.execute("c", {
			id: "T-1",
			status: "completed",
			override: "trust me",
		});
		expect(byAgent.isError).toBe(true);
		const byCopilot = await tools(repo, "mission-copilot").update.execute("c", {
			id: "T-1",
			status: "completed",
			override: "superseded by T-2",
		});
		expect(byCopilot.isError).toBeFalsy();
		expect(ran).toHaveLength(0);
		const t = (await repo.readTree(missionId)).tasks[0];
		expect(t?.notes.at(-1)).toContain(
			"override (mission-copilot): superseded by T-2",
		);
	});
});

describe("work orders: what the agent sees", () => {
	it("shows the work order of an open task, and only the title of a deferred one", async () => {
		const repo = createFakeObjectivesRepository();
		const { add } = tools(repo, "user");
		await add.execute("c", {
			id: "T-1",
			title: "Open one",
			assignee: "alice",
			instructions: "Read <the> runs.",
			doneWhen: "Queue empty.",
			check: { script: "triage/scripts/check.sh" },
			skills: ["triage"],
		});
		await add.execute("c", {
			id: "T-2",
			title: "Later one",
			assignee: "alice",
			status: "deferred",
			instructions: "Not now.",
		});
		const html =
			renderMyObjectives(await repo.readTree(missionId), "alice") ?? "";
		expect(html).toContain("Instructions: Read &lt;the&gt; runs.");
		expect(html).toContain("Done when: Queue empty.");
		expect(html).toContain("Checked by: <code>triage/scripts/check.sh</code>");
		expect(html).toContain("Must follow skills: triage");
		expect(html).not.toContain("Not now.");
	});
});
