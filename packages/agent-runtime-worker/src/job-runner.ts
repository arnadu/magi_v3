/**
 * Background-job execution: pick up job specs, run each one as the submitting
 * agent's OS user, record the outcome. Split out of daemon.ts so the
 * attribution logic is unit-testable without the daemon's entry point.
 *
 * Two queues, two trust levels (ADR-0033's identity model):
 *
 * - `shared/jobs/pending/` is written by agents (`submit-job.sh` runs inside
 *   the agent's own Bash turn). The spec's `agentId` field is **not** trusted:
 *   the submitter is whoever owns the file. Only the daemon can `sudo`, so a
 *   file's owner uid is the one thing an agent cannot forge — a spec naming
 *   another agent used to run as that agent and receive that agent's Tool API
 *   token (JOB1). A symlink, a hard link, a daemon-owned file (a rename keeps
 *   the daemon's uid) or an unknown owner is refused. The file name must be
 *   the job id, a slug, and match `spec.id` (JOB2 — ids become paths).
 * - `<mission>/jobs-private/{queue,running,status,failed}` sits beside
 *   `shared/` with no agent ACL, like `shared.git`. Everything the daemon
 *   writes about a job goes there: specs it authors itself (the copilot's
 *   RestartBackgroundJob, orphan recovery), the running set, and the
 *   authoritative status. `shared/jobs/status/` is kept as an agent-readable
 *   mirror so `ls` and ListBackgroundJobs keep working.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	chmodSync,
	createWriteStream,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TeamConfig } from "@magi/agent-config";
import { JOB_ID_RE, type JobSpec } from "./job-recovery.js";
import { resolveLinuxUsers } from "./linux-user.js";
import type { MailboxRepository } from "./mailbox.js";
import { MISSION_COPILOT_AGENT_ID } from "./mission-copilot.js";
import { removeIfExists } from "./remove-if-exists.js";
import { readInside, writeFileInside } from "./safe-path.js";
import type { ToolApiServer } from "./tool-api-server.js";
import type { AclPolicy } from "./tools.js";
import type { AgentIdentity } from "./workspace-manager.js";

export const DEFAULT_JOB_TIMEOUT_MS = 30 * 60_000;
export const MAX_CONCURRENT_JOBS = 3;
/** A job spec file larger than this is not a spec. */
const MAX_SPEC_BYTES = 64 * 1024;

export interface JobDirs {
	/** Agent-writable submission queue (`shared/jobs/pending`). */
	pending: string;
	/** Agent-readable mirror of finished jobs (`shared/jobs/status`). */
	statusMirror: string;
	/** Agent-readable logs (`shared/logs`). */
	logs: string;
	/** Daemon-private root beside `shared/` (`<mission>/jobs-private`). */
	privateRoot: string;
	/** Daemon-authored specs waiting to run. */
	queue: string;
	running: string;
	failed: string;
	/** Authoritative status records. */
	status: string;
}

/** Directory layout for a mission's jobs, derived from its sharedDir. */
export function jobDirs(sharedDir: string): JobDirs {
	const privateRoot = join(dirname(sharedDir), "jobs-private");
	return {
		pending: join(sharedDir, "jobs", "pending"),
		statusMirror: join(sharedDir, "jobs", "status"),
		logs: join(sharedDir, "logs"),
		privateRoot,
		queue: join(privateRoot, "queue"),
		running: join(privateRoot, "running"),
		failed: join(privateRoot, "failed"),
		status: join(privateRoot, "status"),
	};
}

/** Create the private directories (0700 — only the daemon identity). */
export function ensureJobDirs(dirs: JobDirs): void {
	for (const d of [dirs.queue, dirs.running, dirs.failed, dirs.status]) {
		mkdirSync(d, { recursive: true, mode: 0o700 });
	}
}

/**
 * The agents' submission directory, created by the daemon so every agent can
 * write to it. A directory the daemon makes with 0755 under `shared/` inherits
 * the agents' default ACL entries but gets an ACL *mask* of `r-x` from its
 * group bits, which clips those entries to read-only — so it is made
 * world-writable with the sticky bit, like /tmp: anyone can add a spec,
 * only the owner (or the daemon) can remove one.
 */
export function ensureSubmissionDir(pending: string): void {
	mkdirSync(pending, { recursive: true });
	try {
		chmodSync(pending, 0o1777);
	} catch (e) {
		console.error(
			`[daemon:jobs] Could not make ${pending} writable for agents: ${(e as Error).message}`,
		);
	}
}

/** Write a daemon-authored spec into the private queue (never into the agents' pending dir). */
export function enqueuePrivateJob(dirs: JobDirs, spec: JobSpec): string {
	if (!JOB_ID_RE.test(spec.id)) throw new Error(`Invalid job id "${spec.id}"`);
	ensureJobDirs(dirs);
	return writeFileInside(
		dirs.privateRoot,
		`queue/${spec.id}.json`,
		JSON.stringify(spec, null, 2),
		{
			exclusive: true,
		},
	);
}

/** jobId → live ChildProcess, so CancelBackgroundJob can reach a running job's process group. */
const runningJobProcesses = new Map<string, ChildProcess>();
let runningJobs = 0;

/** How many jobs are running right now (the resource sampler reports it). */
export function runningJobCount(): number {
	return runningJobs;
}

/**
 * Kill a running background job's entire process group (the same
 * SIGKILL-the-group the wall-clock timeout uses). False when the job isn't
 * running — already exited, or unknown id.
 */
export function cancelBackgroundJob(jobId: string): boolean {
	const child = runningJobProcesses.get(jobId);
	if (!child || child.pid === undefined) return false;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		return false;
	}
	cancelledJobs.add(jobId);
	return true;
}

/** Jobs killed by CancelBackgroundJob, so their exit is recorded as cancelled, not failed (MC9). */
const cancelledJobs = new Set<string>();

/**
 * Interpreter argv prefix from the script's shebang: `#!/usr/bin/env <cmd>`
 * → `/usr/bin/env <cmd>`, so the job's PATH resolves it as the shebang
 * intends (it used to become `/usr/local/bin/<cmd>`, which broke
 * `#!/usr/bin/env bash` where bash lives in /usr/bin — #85); direct paths
 * as-is, [] when absent. WriteFile
 * creates files without +x and the file belongs to another user, so the
 * interpreter is prepended instead of chmod-ing.
 */
export function readShebangInterpreter(scriptPath: string): string[] {
	try {
		const head = readFileSync(scriptPath, "utf8").slice(0, 256);
		const firstLine = head.split("\n")[0] ?? "";
		if (!firstLine.startsWith("#!")) return [];
		const shebang = firstLine.slice(2).trim();
		const envMatch = shebang.match(/^\/usr\/bin\/env\s+(\S+)/);
		if (envMatch) return ["/usr/bin/env", envMatch[1]];
		return [shebang.split(/\s+/)[0]];
	} catch {
		return [];
	}
}

export interface JobRunnerDeps {
	sharedDir: string;
	workdir: string;
	missionId: string;
	teamConfig: TeamConfig;
	toolApiServer: ToolApiServer;
	toolPort: number;
	mailboxRepo: MailboxRepository;
	missionCopilotEnabled: boolean;
	/** Owner uid → agentId, built at boot from the roster's OS users. */
	uidToAgentId: ReadonlyMap<number, string>;
	/** The daemon's own uid: a pending file it owns was renamed or planted, never submitted. */
	daemonUid: number;
	/** Injected by tests. */
	spawnFn?: typeof spawn;
	/** Injected by tests to simulate file ownership. */
	ownerUidOf?: (path: string) => number;
	/** Records a refused spec (defaults to console.error). */
	onRejected?: (file: string, reason: string) => void;
}

type Claimed = {
	spec: JobSpec;
	source: "pending" | "queue";
	runningPath: string;
};

/**
 * Validate and claim one agent-submitted spec: ownership → agentId, name →
 * id, then move it into the private running set. Returns null (and reports)
 * when anything about it cannot be trusted. The file in pending/ is removed
 * either way so a bad spec cannot be retried forever.
 */
function claimPending(
	file: string,
	deps: JobRunnerDeps,
	dirs: JobDirs,
): Claimed | null {
	const reject = (reason: string): null => {
		(
			deps.onRejected ??
			((f, r) => console.error(`[daemon:jobs] Refused ${f}: ${r}`))
		)(file, reason);
		removeIfExists(
			join(dirs.pending, file),
			"the refused spec stays in pending and is refused again next tick",
		);
		return null;
	};
	const stem = file.replace(/\.json$/, "");
	if (!JOB_ID_RE.test(stem)) return reject("file name is not a job id");
	const path = join(dirs.pending, file);
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(path);
	} catch {
		return null; // gone between readdir and here
	}
	if (st.isSymbolicLink()) return reject("symlink");
	if (!st.isFile()) return reject("not a regular file");
	if (st.nlink > 1) return reject("hard link");
	if (st.size > MAX_SPEC_BYTES) return reject("spec too large");
	const uid = deps.ownerUidOf ? deps.ownerUidOf(path) : st.uid;
	if (uid === deps.daemonUid)
		return reject("owned by the daemon (renamed or planted, not submitted)");
	const owner = deps.uidToAgentId.get(uid);
	if (!owner) return reject(`owner uid ${uid} is not an agent of this mission`);

	let spec: JobSpec;
	try {
		spec = JSON.parse(
			readInside(dirs.pending, file, {
				maxBytes: MAX_SPEC_BYTES,
			}).bytes.toString("utf8"),
		);
	} catch (e) {
		return reject(`unreadable or malformed: ${(e as Error).message}`);
	}
	if (spec.id !== stem)
		return reject(`spec.id "${spec.id}" does not match the file name`);
	if (spec.agentId !== owner) {
		return reject(
			`spec.agentId "${spec.agentId}" but the file is owned by "${owner}" — jobs run as their submitter`,
		);
	}
	if (!Array.isArray(spec.args) || typeof spec.scriptPath !== "string")
		return reject("spec shape");
	const runningPath = join(dirs.running, file);
	try {
		writeFileInside(
			dirs.privateRoot,
			`running/${file}`,
			JSON.stringify(spec, null, 2),
			{ exclusive: true },
		);
		unlinkSync(path);
	} catch (e) {
		return reject(`could not claim: ${(e as Error).message}`);
	}
	return { spec, source: "pending", runningPath };
}

/** Claim one daemon-authored spec from the private queue (trusted as written, id still checked). */
function claimQueued(file: string, dirs: JobDirs): Claimed | null {
	const stem = file.replace(/\.json$/, "");
	if (!JOB_ID_RE.test(stem)) return null;
	let spec: JobSpec;
	try {
		spec = JSON.parse(readFileSync(join(dirs.queue, file), "utf8")) as JobSpec;
	} catch {
		return null;
	}
	if (spec.id !== stem) return null;
	const runningPath = join(dirs.running, file);
	try {
		writeFileSync(runningPath, JSON.stringify(spec, null, 2), { flag: "wx" });
		unlinkSync(join(dirs.queue, file));
	} catch {
		return null;
	}
	return { spec, source: "queue", runningPath };
}

/**
 * Run every claimable job (up to MAX_CONCURRENT_JOBS at a time): the agent
 * queue with ownership attribution, then the private queue. Called from the
 * daemon's 60 s tick.
 */
export async function runPendingJobs(deps: JobRunnerDeps): Promise<void> {
	const dirs = jobDirs(deps.sharedDir);
	ensureJobDirs(dirs);
	ensureSubmissionDir(dirs.pending);
	mkdirSync(dirs.statusMirror, { recursive: true });
	mkdirSync(dirs.logs, { recursive: true });

	const candidates: Array<() => Claimed | null> = [];
	try {
		for (const f of readdirSync(dirs.pending).filter((f) =>
			f.endsWith(".json"),
		)) {
			candidates.push(() => claimPending(f, deps, dirs));
		}
	} catch {
		// pending dir does not exist yet
	}
	for (const f of readdirSync(dirs.queue).filter((f) => f.endsWith(".json"))) {
		candidates.push(() => claimQueued(f, dirs));
	}

	for (const claim of candidates) {
		if (runningJobs >= MAX_CONCURRENT_JOBS) break;
		const claimed = claim();
		if (claimed) startJob(claimed, deps, dirs);
	}
}

interface JobIdentity {
	linuxUser: string;
	agentWorkdir: string;
	permittedPaths: string[];
	resolvedScript: string;
}

/**
 * Who the job runs as and what it may touch, from the roster — never from the
 * spec. The script must physically live inside the agent's permitted trees
 * (a symlink to an arbitrary executable is refused). Returns the reason when
 * the job cannot run.
 */
function resolveJobIdentity(
	spec: JobSpec,
	deps: JobRunnerDeps,
): JobIdentity | { refused: string } {
	const { teamConfig, sharedDir, workdir, missionId } = deps;
	const agentCfg = teamConfig.agents.find((a) => a.id === spec.agentId);
	if (!agentCfg) return { refused: `unknown agentId "${spec.agentId}"` };
	const linuxUser = resolveLinuxUsers(teamConfig.agents).get(agentCfg.id);
	if (!linuxUser)
		return { refused: `no Linux user for agentId "${spec.agentId}"` };
	const agentWorkdir = join(workdir, "home", linuxUser, "missions", missionId);
	const permittedPaths = [agentWorkdir, sharedDir];
	try {
		const resolvedScript = resolve(spec.scriptPath);
		const realScript = realpathSync(resolvedScript);
		const allowed = permittedPaths.some(
			(p) => realScript === p || realScript.startsWith(`${p}/`),
		);
		if (!allowed) {
			return {
				refused: `scriptPath "${spec.scriptPath}" resolves outside permitted paths`,
			};
		}
		return { linuxUser, agentWorkdir, permittedPaths, resolvedScript };
	} catch (e) {
		return {
			refused: `scriptPath "${spec.scriptPath}" could not be resolved: ${(e as Error).message}`,
		};
	}
}

function startJob(
	claimed: Claimed,
	deps: JobRunnerDeps,
	dirs: JobDirs,
): undefined {
	const { spec, runningPath } = claimed;
	const drop = (reason: string): undefined => {
		console.error(`[daemon:jobs] Not starting job ${spec.id}: ${reason}`);
		removeIfExists(
			runningPath,
			"the job stays marked running and recovery will treat it as orphaned",
		);
		return undefined;
	};
	const who = resolveJobIdentity(spec, deps);
	if ("refused" in who) return drop(who.refused);
	const { linuxUser, agentWorkdir, permittedPaths, resolvedScript } = who;

	const acl: AclPolicy = { agentId: spec.agentId, linuxUser, permittedPaths };
	const identity: AgentIdentity = {
		workdir: agentWorkdir,
		sharedDir: deps.sharedDir,
		linuxUser,
	};

	// Issue the token right before the spawn and revoke it the moment the spawn
	// fails, so the window in which it exists unused is as short as possible.
	const token = deps.toolApiServer.issueToken(acl, identity);
	const logPath = join(dirs.logs, `bg-${spec.id}.log`);
	const logStream = createWriteStream(logPath, { flags: "a" });
	// A failed log open (disk full, directory removed) must not take the daemon
	// down with an unhandled "error" event; the job still runs, unlogged.
	logStream.on("error", (e) =>
		console.error(
			`[daemon:jobs] Log stream for ${spec.id} failed: ${(e as Error).message}`,
		),
	);

	runningJobs++;
	const interpreter = readShebangInterpreter(resolvedScript);
	console.log(
		`[daemon:jobs] Starting job ${spec.id} (${spec.scriptPath}) as ${linuxUser}`,
	);

	let child: ChildProcess;
	try {
		child = (deps.spawnFn ?? spawn)(
			"sudo",
			[
				"-u",
				linuxUser,
				"/usr/local/bin/magi-job",
				...interpreter,
				resolvedScript,
				...spec.args,
			],
			{
				// Agent-authored code: only a loopback capability token, never a
				// reusable third-party key (the data-provider tools hold those).
				env: {
					PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
					HOME: `/home/${linuxUser}`,
					MAGI_TOOL_URL: `http://127.0.0.1:${deps.toolPort}`,
					MAGI_TOOL_TOKEN: token,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (e) {
		runningJobs--;
		deps.toolApiServer.revokeToken(token);
		logStream.end();
		return drop(`spawn failed: ${(e as Error).message}`);
	}

	child.stdout?.pipe(logStream);
	child.stderr?.pipe(logStream);
	runningJobProcesses.set(spec.id, child);

	// Wall-clock timeout — kill the entire process group.
	const jobTimeoutMs = spec.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
	const timeoutHandle = setTimeout(() => {
		console.error(
			`[daemon:jobs] Job ${spec.id} timed out after ${jobTimeoutMs}ms — killing`,
		);
		if (child.pid !== undefined) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch (e) {
				// ESRCH: the group already exited between the timeout and the kill.
				if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
					console.error(
						`[daemon:jobs] Could not kill job ${spec.id}'s process group: ${(e as Error).message} — it may keep running past its timeout`,
					);
				}
			}
		} else {
			child.kill("SIGKILL");
		}
	}, jobTimeoutMs);

	child.on("close", (exitCode) => {
		clearTimeout(timeoutHandle);
		runningJobs--;
		runningJobProcesses.delete(spec.id);
		deps.toolApiServer.revokeToken(token);
		logStream.end();
		removeIfExists(
			runningPath,
			"the finished job stays marked running until recovery clears it",
		);
		recordJobExit(spec, exitCode, logPath, deps, dirs);
	});
}

/**
 * Persist the outcome and notify. The status record carries the full spec so
 * RestartBackgroundJob can resubmit an exact retry; the private copy is
 * authoritative (it is what RestartBackgroundJob reads), the shared copy is
 * the agents' mirror.
 */
function recordJobExit(
	spec: JobSpec,
	exitCode: number | null,
	logPath: string,
	deps: JobRunnerDeps,
	dirs: JobDirs,
): void {
	const { missionId, mailboxRepo, teamConfig, sharedDir } = deps;
	const cancelled = cancelledJobs.delete(spec.id);
	const status = {
		id: spec.id,
		agentId: spec.agentId,
		scriptPath: spec.scriptPath,
		args: spec.args,
		notifyAgentId: spec.notifyAgentId,
		notifySubject: spec.notifySubject,
		timeoutMs: spec.timeoutMs,
		exitCode: exitCode ?? -1,
		...(cancelled && { cancelled: true }),
		completedAt: new Date().toISOString(),
		logPath,
	};
	const statusJson = JSON.stringify(status, null, 2);
	try {
		writeFileSync(join(dirs.status, `${spec.id}.json`), statusJson);
	} catch (e) {
		console.error(
			`[daemon:jobs] Failed to write status for ${spec.id}: ${(e as Error).message}`,
		);
	}
	try {
		writeFileInside(sharedDir, `jobs/status/${spec.id}.json`, statusJson);
	} catch (e) {
		console.error(
			`[daemon:jobs] Failed to mirror status for ${spec.id}: ${(e as Error).message}`,
		);
	}

	const success = exitCode === 0;
	const outcome = success ? "ok" : cancelled ? "cancelled" : "FAILED";
	console.log(
		`[daemon:jobs] Job ${spec.id} exited ${exitCode ?? "null"} — ${outcome}`,
	);
	const notify = (to: string, subject: string, body: string) =>
		mailboxRepo
			.post({ missionId, from: "scheduler", to: [to], subject, body })
			.catch((e: unknown) =>
				console.error(
					`[daemon:jobs] Failed to notify ${to} about job ${spec.id}: ${(e as Error).message}`,
				),
			);

	if (spec.notifyAgentId) {
		notify(
			spec.notifyAgentId,
			spec.notifySubject ?? `Background job complete: ${spec.id}`,
			success
				? `Job completed successfully.\nLog: ${logPath}`
				: cancelled
					? `Job cancelled (killed by CancelBackgroundJob).\nLog: ${logPath}`
					: `Job FAILED (exit ${exitCode ?? "null"}).\nLog: ${logPath}`,
		);
	}
	// A failed job is otherwise visible only in its status file; the mission
	// copilot is the one agent positioned to investigate (issue #3).
	if (
		!success &&
		!cancelled &&
		deps.missionCopilotEnabled &&
		teamConfig.agents.some((a) => a.id === MISSION_COPILOT_AGENT_ID)
	) {
		notify(
			MISSION_COPILOT_AGENT_ID,
			`Background job failed: ${spec.id}`,
			`Job "${spec.id}" (submitted by "${spec.agentId}") exited ${exitCode ?? "null"}.\nScript: ${spec.scriptPath}\nLog: ${logPath}`,
		);
	}
}
