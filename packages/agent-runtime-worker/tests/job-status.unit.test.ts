/**
 * readFailedJobStatus — the mission copilot's RestartBackgroundJob reads a
 * status file under agent-writable sharedDir as the daemon (MC8, audit
 * 2026-10): the id must be a slug, the file must not be a symlink, and a job
 * that exited 0 is not restartable.
 */

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOB_ID_RE, readFailedJobStatus } from "../src/job-recovery.js";

let base: string;
let shared: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "job-status-")));
	shared = join(base, "shared");
	mkdirSync(join(shared, "jobs", "status"), { recursive: true });
	mkdirSync(join(base, "outside"));
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

function status(id: string, exitCode: number) {
	writeFileSync(
		join(shared, "jobs", "status", `${id}.json`),
		JSON.stringify({
			id,
			agentId: "a1",
			scriptPath: "/x/run.sh",
			args: [],
			exitCode,
		}),
	);
}

describe("readFailedJobStatus", () => {
	it("returns the spec of a job that exited non-zero", () => {
		status("job-1", 2);
		const r = readFailedJobStatus(shared, "job-1");
		expect("spec" in r && r.spec.exitCode).toBe(2);
	});

	it("refuses a job that exited 0", () => {
		status("job-ok", 0);
		const r = readFailedJobStatus(shared, "job-ok");
		expect("error" in r && r.error).toMatch(/completed successfully/);
	});

	it("rejects ids that are not slugs (traversal never reaches the path)", () => {
		for (const id of ["../../etc/passwd", "a/b", "", ".hidden", "x y"]) {
			expect(JOB_ID_RE.test(id), id).toBe(false);
			const r = readFailedJobStatus(shared, id);
			expect("error" in r && r.error, id).toMatch(/Invalid job id/);
		}
		expect(JOB_ID_RE.test("3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b")).toBe(true);
	});

	it("does not follow a symlinked status file", () => {
		writeFileSync(join(base, "outside", "planted.json"), "{}");
		symlinkSync(
			join(base, "outside", "planted.json"),
			join(shared, "jobs", "status", "link.json"),
		);
		const r = readFailedJobStatus(shared, "link");
		expect("error" in r && r.error).toMatch(/No completed job/);
	});

	it("reports a missing status file as not found", () => {
		const r = readFailedJobStatus(shared, "nope");
		expect("error" in r && r.error).toMatch(/No completed job "nope"/);
	});
});
