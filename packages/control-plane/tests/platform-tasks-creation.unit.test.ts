/**
 * A mission's platform tasks come only from its template: a template's tasks are copied when a
 * mission is created from it, an invalid list makes the template unusable, and a draft without
 * a template gets none. (A caller's inline config never carries them: resolveCreateConfig.)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MissionDoc } from "@magi/agent-config";
import type { Collection } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDraftMission } from "../src/mission-drafts.js";
import { getTemplate, loadTemplates } from "../src/templates.js";

const TEAM = `
mission:
  id: tmpl
  name: "Reviewers"
agents:
  - id: analyst
    supervisor: user
    systemPrompt: |
      You are an analyst.
    initialMentalMap: |
      <section id="status"><p>Ready.</p></section>
`;
const TASKS = `
platformTasks:
  - kind: git-mirror
    name: magi-v3
    params:
      url: https://github.com/arnadu/magi_v3
      branch: main
`;

function fakeCollection() {
	const inserted: MissionDoc[] = [];
	const col = {
		findOne: async () => null,
		insertOne: async (d: MissionDoc) => {
			inserted.push(d);
			return { acknowledged: true };
		},
	} as unknown as Collection<MissionDoc>;
	return { col, inserted };
}

describe("platform tasks at mission creation", () => {
	let repoRoot: string;
	beforeEach(() => {
		repoRoot = mkdtempSync(join(tmpdir(), "magi-ptasks-"));
		mkdirSync(join(repoRoot, "config", "teams"), { recursive: true });
	});
	afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

	function load(files: Record<string, string>) {
		for (const [name, yaml] of Object.entries(files)) {
			writeFileSync(join(repoRoot, "config", "teams", name), yaml);
		}
		loadTemplates(repoRoot);
	}

	it("a template's tasks are loaded with it, and copied into a draft created from it", async () => {
		load({ "reviewers.yaml": TEAM + TASKS, "plain.yaml": TEAM });
		expect(getTemplate("reviewers")?.platformTasks).toHaveLength(1);
		expect(getTemplate("plain")?.platformTasks).toEqual([]);

		const { col, inserted } = fakeCollection();
		const r = await createDraftMission(col, {
			missionId: "rev-1",
			name: "Rev",
			templateId: "reviewers",
			userId: "u1",
		});
		expect(r.ok).toBe(true);
		expect(inserted[0].platformTasks).toEqual([
			{
				kind: "git-mirror",
				name: "magi-v3",
				params: { url: "https://github.com/arnadu/magi_v3", branch: "main" },
				everyMinutes: 15,
			},
		]);
	});

	it("a template with an invalid task list is not loaded", () => {
		load({
			"bad.yaml": `${TEAM}platformTasks:\n  - kind: shell\n    name: x\n    params: {}\n`,
		});
		expect(getTemplate("bad")).toBeNull();
	});

	it("a blank draft has no platform tasks", async () => {
		load({ "reviewers.yaml": TEAM + TASKS });
		const { col, inserted } = fakeCollection();
		await createDraftMission(col, {
			missionId: "blank-1",
			name: "Blank",
			userId: "u1",
		});
		expect(inserted[0].platformTasks).toEqual([]);
	});
});
