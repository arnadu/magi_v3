import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type JobSpec,
	MAX_JOB_RECOVERY_ATTEMPTS,
	recoverOrphanedJobs,
} from "../src/job-recovery.js";
import type { MailboxMessage, MailboxRepository } from "../src/mailbox.js";

function fakeMailbox(): MailboxRepository & { posted: MailboxMessage[] } {
	const posted: MailboxMessage[] = [];
	return {
		posted,
		async post(msg) {
			const full: MailboxMessage = {
				...msg,
				id: String(posted.length),
				timestamp: new Date(),
				readBy: [],
			};
			posted.push(full);
			return full;
		},
		async listUnread() {
			return [];
		},
		async markRead() {},
		async hasUnread() {
			return false;
		},
		async list() {
			return [];
		},
		async get() {
			return null;
		},
	};
}

const MISSION = "m1";

function writeRunningJob(sharedDir: string, spec: JobSpec): string {
	const runningDir = join(sharedDir, "jobs", "running");
	writeFileSync(
		join(runningDir, `${spec.id}.json`),
		JSON.stringify(spec, null, 2),
	);
	return join(runningDir, `${spec.id}.json`);
}

describe("recoverOrphanedJobs", () => {
	let sharedDir: string;

	beforeEach(() => {
		sharedDir = mkdtempSync(join(tmpdir(), "job-recovery-test-"));
		mkdirSync(join(sharedDir, "jobs", "running"), { recursive: true });
	});

	afterEach(() => {
		rmSync(sharedDir, { recursive: true, force: true });
	});

	it("does nothing when there is no running/ dir at all", async () => {
		rmSync(join(sharedDir, "jobs"), { recursive: true, force: true });
		const mailbox = fakeMailbox();
		await expect(
			recoverOrphanedJobs(sharedDir, MISSION, mailbox),
		).resolves.toBeUndefined();
		expect(mailbox.posted).toHaveLength(0);
	});

	it("recovers a first-time orphan: moves to pending/ with recoveryAttempts=1", async () => {
		const spec: JobSpec = {
			id: "job-1",
			agentId: "analyst",
			scriptPath: "/x/script.py",
			args: [],
		};
		writeRunningJob(sharedDir, spec);
		const mailbox = fakeMailbox();

		await recoverOrphanedJobs(sharedDir, MISSION, mailbox);

		const runningFiles = readdirSync(join(sharedDir, "jobs", "running"));
		expect(runningFiles).toHaveLength(0);
		const pendingFiles = readdirSync(join(sharedDir, "jobs", "pending"));
		expect(pendingFiles).toEqual(["job-1.json"]);
		const recovered = JSON.parse(
			readFileSync(join(sharedDir, "jobs", "pending", "job-1.json"), "utf8"),
		);
		expect(recovered.recoveryAttempts).toBe(1);
		expect(mailbox.posted).toHaveLength(0); // no notification yet — still under the cap
	});

	it("fails a job out permanently once it exceeds MAX_JOB_RECOVERY_ATTEMPTS, instead of re-queueing it", async () => {
		const spec: JobSpec = {
			id: "job-2",
			agentId: "analyst",
			scriptPath: "/x/oom.py",
			args: [],
			notifyAgentId: "analyst",
			recoveryAttempts: MAX_JOB_RECOVERY_ATTEMPTS, // already at the cap
		};
		writeRunningJob(sharedDir, spec);
		const mailbox = fakeMailbox();

		await recoverOrphanedJobs(sharedDir, MISSION, mailbox);

		// NOT re-queued.
		expect(() => readdirSync(join(sharedDir, "jobs", "pending"))).not.toThrow();
		const pendingFiles = readdirSync(join(sharedDir, "jobs", "pending"));
		expect(pendingFiles).toHaveLength(0);
		const runningFiles = readdirSync(join(sharedDir, "jobs", "running"));
		expect(runningFiles).toHaveLength(0);

		// Moved to failed/, with a status file explaining why.
		const failedFiles = readdirSync(join(sharedDir, "jobs", "failed"));
		expect(failedFiles).toEqual(["job-2.json"]);
		const statusFiles = readdirSync(join(sharedDir, "jobs", "status"));
		expect(statusFiles).toEqual(["job-2.json"]);
		const status = JSON.parse(
			readFileSync(join(sharedDir, "jobs", "status", "job-2.json"), "utf8"),
		);
		expect(status.error).toMatch(/exceeded/i);

		// Operator/agent notified.
		expect(mailbox.posted).toHaveLength(1);
		expect(mailbox.posted[0].to).toEqual(["analyst"]);
		expect(mailbox.posted[0].subject).toMatch(/permanently failed/i);
	});

	it("notifies 'user' when the job has no notifyAgentId", async () => {
		const spec: JobSpec = {
			id: "job-3",
			agentId: "analyst",
			scriptPath: "/x/oom.py",
			args: [],
			recoveryAttempts: MAX_JOB_RECOVERY_ATTEMPTS,
		};
		writeRunningJob(sharedDir, spec);
		const mailbox = fakeMailbox();

		await recoverOrphanedJobs(sharedDir, MISSION, mailbox);

		expect(mailbox.posted[0].to).toEqual(["user"]);
	});

	it("leaves a malformed job file in place rather than deleting or re-queueing it", async () => {
		writeFileSync(
			join(sharedDir, "jobs", "running", "broken.json"),
			"{not json",
		);
		const mailbox = fakeMailbox();

		await recoverOrphanedJobs(sharedDir, MISSION, mailbox);

		const runningFiles = readdirSync(join(sharedDir, "jobs", "running"));
		expect(runningFiles).toEqual(["broken.json"]);
		expect(mailbox.posted).toHaveLength(0);
	});
});
