/**
 * Platform tasks (operation `mission.platform-task`): the daemon runs each of the mission's tasks
 * at boot and then every `everyMinutes`, as the `magi-platform` user through the root-owned
 * `magi-task` wrapper (one sudo rule; sudo resets the environment, so a task never holds the
 * daemon's secrets). The kinds are code in the image; the mission only chooses kind, schedule and
 * parameters, validated by the schema here and again by the wrapper.
 *
 * A failed run leaves the last good output in place (the wrapper switches outputs atomically).
 * Consecutive failures raise one anomaly per streak. A run still going when its next turn comes
 * is not started twice.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import {
	entryTrigger,
	type PlatformTask,
	parsePlatformTasks,
} from "@magi/agent-config";
import type { AnomalyRecorder } from "./anomaly.js";

const execFileP = promisify(execFile);

export const MAGI_TASK = "/usr/local/sbin/magi-task";
/** How long one run may take before it is killed (a first clone of a large repository included). */
export const TASK_TIMEOUT_MS = 10 * 60_000;
/** Consecutive failures before the operator is told. */
export const FAILURES_BEFORE_ANOMALY = 3;

export type TaskOutcome =
	| { ok: true; output: string }
	| { ok: false; error: string };

/** The wrapper's arguments for one task: fixed per kind, never assembled from free text. */
export function taskArgs(task: PlatformTask): string[] {
	switch (task.kind) {
		case "git-mirror":
			return [task.kind, task.name, task.params.url, task.params.branch];
	}
}

/** Run one task through sudo and the wrapper. */
export async function runTaskWithSudo(
	task: PlatformTask,
): Promise<TaskOutcome> {
	try {
		const { stdout } = await execFileP(
			"sudo",
			["-n", "-u", "magi-platform", MAGI_TASK, ...taskArgs(task)],
			{
				env: { PATH: "/usr/bin:/bin" },
				timeout: TASK_TIMEOUT_MS,
				maxBuffer: 1 << 20,
			},
		);
		return { ok: true, output: stdout.trim().slice(0, 200) };
	} catch (e) {
		const err = e as Error & { stderr?: string; killed?: boolean };
		const why = err.killed
			? `timed out after ${TASK_TIMEOUT_MS / 60_000} min`
			: (err.stderr?.trim() || err.message).slice(-500);
		return { ok: false, error: why };
	}
}

export interface PlatformTaskDeps {
	missionId: string;
	/** The mission document's `platformTasks` (unvalidated), or a team YAML's. */
	rawTasks: unknown;
	anomalies: Pick<AnomalyRecorder, "record">;
	/** True on Fly: a missing wrapper or an invalid task list is then an anomaly, not a log line. */
	onFly: boolean;
	run?: (task: PlatformTask) => Promise<TaskOutcome>;
	wrapperExists?: () => boolean;
	log?: (line: string) => void;
}

export interface PlatformTaskRunner {
	tasks: readonly PlatformTask[];
	/** Run one task now unless it is already running; resolves when that run ends. */
	runNow(name: string): Promise<TaskOutcome | "busy" | "unknown">;
	stop(): void;
}

/** Starts every task: a run now, then one every `everyMinutes`. */
export function startPlatformTasks(deps: PlatformTaskDeps): PlatformTaskRunner {
	const log = deps.log ?? ((l) => console.log(l));
	const run = deps.run ?? runTaskWithSudo;
	const report = (message: string) =>
		deps.anomalies.record({
			missionId: deps.missionId,
			category: "platform-task-failure",
			severity: "soft",
			message,
		});

	let tasks: PlatformTask[];
	try {
		tasks = parsePlatformTasks(deps.rawTasks);
	} catch (e) {
		const msg = `[platform-tasks] the mission's platform tasks are invalid, none will run: ${(e as Error).message}`;
		console.error(msg);
		void report(msg);
		return idle([]);
	}
	if (tasks.length === 0) return idle([]);
	if (!(deps.wrapperExists ?? (() => existsSync(MAGI_TASK)))()) {
		const msg = `[platform-tasks] ${MAGI_TASK} is not installed: ${tasks.length} platform task(s) will not run (${tasks.map((t) => t.name).join(", ")})`;
		if (deps.onFly) {
			console.error(msg);
			void report(msg);
		} else log(`${msg}; expected outside the mission image`);
		return idle(tasks);
	}

	const running = new Set<string>();
	const failures = new Map<string, number>();
	const timers: NodeJS.Timeout[] = [];

	async function runNow(
		name: string,
	): Promise<TaskOutcome | "busy" | "unknown"> {
		const task = tasks.find((t) => t.name === name);
		if (!task) return "unknown";
		if (running.has(name)) return "busy";
		running.add(name);
		try {
			const outcome = await run(task);
			const before = failures.get(name) ?? 0;
			if (outcome.ok) {
				failures.set(name, 0);
				log(
					`[platform-tasks] ${task.kind} ${name}: ${outcome.output}${before > 0 ? ` (recovered after ${before} failure(s))` : ""}`,
				);
			} else {
				const n = before + 1;
				failures.set(name, n);
				console.error(
					`[platform-tasks] ${task.kind} ${name} failed (${n} in a row; the last good output stays): ${outcome.error}`,
				);
				if (n === FAILURES_BEFORE_ANOMALY) {
					await report(
						`Platform task ${name} (${task.kind}) failed ${n} times in a row; its output is stale. Last error: ${outcome.error}`,
					);
				}
			}
			return outcome;
		} finally {
			running.delete(name);
		}
	}

	for (const task of tasks) {
		const tick = entryTrigger("mission.platform-task", async () => {
			await runNow(task.name);
		});
		void tick();
		timers.push(setInterval(tick, task.everyMinutes * 60_000));
	}
	return {
		tasks,
		runNow,
		stop() {
			for (const t of timers) clearInterval(t);
		},
	};
}

function idle(tasks: PlatformTask[]): PlatformTaskRunner {
	return { tasks, runNow: async () => "unknown", stop() {} };
}
