/**
 * Incident-driven fix (Gold Digest V2, 2026-07-21): objectives/ is agent- and
 * copilot-writable mission state living on the Fly volume, meant to survive
 * suspend/resume. copyTeamFilesToSharedDir used to unconditionally overwrite
 * sharedDir from MongoDB's teamFiles snapshot on every provision() call
 * (i.e. every resume) — silently rolling back real, evolved objectives to
 * whatever stale snapshot MongoDB happened to have. These tests cover the
 * fix directly: seed-if-missing, never overwrite existing objectives/ files.
 *
 * setfacl calls inside the function are best-effort (caught, ignored) — no
 * pool users or sudo needed to exercise the core copy logic here.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyTeamFilesToSharedDir } from "../src/workspace-manager.js";

let tmp: string;
let sharedDir: string;
let teamDir: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "magi-wm-objectives-"));
	sharedDir = join(tmp, "shared");
	teamDir = join(tmp, "team");
	mkdirSync(sharedDir, { recursive: true });
	mkdirSync(join(teamDir, "objectives"), { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("copyTeamFilesToSharedDir — objectives/ seed-if-missing", () => {
	it("seeds objectives/goals.json when sharedDir doesn't have it yet (fresh mission)", () => {
		writeFileSync(
			join(teamDir, "objectives", "goals.json"),
			'{"objectives":[{"id":"O1"}]}',
		);

		copyTeamFilesToSharedDir(sharedDir, teamDir, []);

		const dest = join(sharedDir, "objectives", "goals.json");
		expect(readFileSync(dest, "utf-8")).toBe('{"objectives":[{"id":"O1"}]}');
	});

	it("does NOT overwrite an existing objectives/goals.json — the resume-time regression", () => {
		// Simulates the real incident: the volume already has evolved content
		// (O1-O4), MongoDB's teamFiles snapshot is stale (only O1-O2, from an
		// earlier SaveMissionConfig call that predates later evolution).
		mkdirSync(join(sharedDir, "objectives"), { recursive: true });
		writeFileSync(
			join(sharedDir, "objectives", "goals.json"),
			'{"objectives":[{"id":"O1"},{"id":"O2"},{"id":"O3"},{"id":"O4"}]}',
		);
		writeFileSync(
			join(teamDir, "objectives", "goals.json"),
			'{"objectives":[{"id":"O1"},{"id":"O2"}]}', // stale Mongo snapshot
		);

		copyTeamFilesToSharedDir(sharedDir, teamDir, []);

		const dest = join(sharedDir, "objectives", "goals.json");
		expect(readFileSync(dest, "utf-8")).toBe(
			'{"objectives":[{"id":"O1"},{"id":"O2"},{"id":"O3"},{"id":"O4"}]}',
		);
	});

	it("does NOT overwrite existing objectives/tasks.jsonl either", () => {
		mkdirSync(join(sharedDir, "objectives"), { recursive: true });
		writeFileSync(join(sharedDir, "objectives", "tasks.jsonl"), "evolved\n");
		writeFileSync(join(teamDir, "objectives", "tasks.jsonl"), "stale\n");

		copyTeamFilesToSharedDir(sharedDir, teamDir, []);

		expect(
			readFileSync(join(sharedDir, "objectives", "tasks.jsonl"), "utf-8"),
		).toBe("evolved\n");
	});

	it("still seeds a NEW file under objectives/ that genuinely doesn't exist on disk yet", () => {
		mkdirSync(join(sharedDir, "objectives"), { recursive: true });
		writeFileSync(join(sharedDir, "objectives", "goals.json"), "existing");
		// teamFiles gained a new file (e.g. kpis.jsonl) not yet present on disk.
		writeFileSync(join(teamDir, "objectives", "kpis.jsonl"), "seed\n");

		copyTeamFilesToSharedDir(sharedDir, teamDir, []);

		expect(
			readFileSync(join(sharedDir, "objectives", "goals.json"), "utf-8"),
		).toBe("existing");
		expect(
			readFileSync(join(sharedDir, "objectives", "kpis.jsonl"), "utf-8"),
		).toBe("seed\n");
	});

	it("non-objectives teamFiles still overwrite unconditionally (unaffected, existing behavior)", () => {
		writeFileSync(join(sharedDir, "playbook.md"), "old operator content");
		writeFileSync(join(teamDir, "playbook.md"), "new operator content");

		copyTeamFilesToSharedDir(sharedDir, teamDir, []);

		expect(readFileSync(join(sharedDir, "playbook.md"), "utf-8")).toBe(
			"new operator content",
		);
	});
});
