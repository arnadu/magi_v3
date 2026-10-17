/**
 * Schedule ingestion (ADR-0033 §3): the bridge between the schedule files
 * agents write with the `schedule-task` and `run-background` skills and the
 * `scheduled_messages` collection the control plane's scheduler fires from.
 *
 * Agents write `shared/schedules/<label>.json`; nothing could read them until
 * this module existed (the skills promised it for two sprints — SCHED1/2).
 * The daemon's 60 s tick now:
 *
 *   1. `ingest()` — upserts one `scheduled_messages` document per file,
 *      keyed `{missionId, origin, label}`. The first sight inserts it, armed
 *      at the cron's next occurrence; a later tick re-arms only when the
 *      spec's hash changed or the document had been cancelled; a label with
 *      no file is cancelled. Edits re-arm, `rm` cancels — within a minute.
 *   2. `claimJobFires()` — for `kind: "job"` schedules the control plane does
 *      not post mail; it stamps `pendingFire` (and wakes the machine). This
 *      turns each stamp into one job in the daemon-private queue, named
 *      `<label>-<dueAt epoch>` so a crash between enqueue and acknowledge
 *      cannot run it twice, then clears the stamp with a compare-and-set on
 *      `dueAt`. A fire more than MAX_JOB_FIRE_LATENESS_MS late (the mission
 *      sat suspended through it) is skipped with a `scheduling-failure`
 *      anomaly instead of running stale work.
 *
 * Trust: a schedule file is agent-authored input acted on by the daemon. The
 * same rules as `job-runner.ts` apply — the author is the file's owner uid
 * (unforgeable: only the daemon can `sudo`), never a field in the file;
 * symlinks, hard links, daemon-owned files and unknown owners are refused;
 * a job schedule may only name its author as the job's agent; recipients
 * must be on the roster; the cron floor that applies to the copilot's own
 * `CreateScheduledMessage` applies here too (each fire is a paid turn or a
 * sudo spawn). Nothing in the file chooses a Linux user or a file path the
 * daemon itself touches — the job spec is re-validated at run time by
 * `resolveJobIdentity` like any other job.
 */

import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { TeamConfig } from "@magi/agent-config";
import type { Collection, Db } from "mongodb";
import type { AnomalyRecorder } from "./anomaly.js";
import type { JobSpec } from "./job-recovery.js";
import { enqueuePrivateJob, jobDirs } from "./job-runner.js";
import { MISSION_COPILOT_AGENT_ID } from "./mission-copilot.js";
import { resolveDeliverAt } from "./mission-copilot-schedule-input.js";
import { readInside } from "./safe-path.js";

export const SCHEDULE_ORIGIN = "shared-schedules" as const;
/** File stem = label. Lower-case slug so it is safe as a label, a job-id prefix and a path component. */
export const SCHEDULE_LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SCHEDULES_DIRNAME = "schedules";
const MAX_SCHEDULE_FILE_BYTES = 64 * 1024;
/** A job fire older than this when the daemon finally sees it is skipped, not run. */
export const MAX_JOB_FIRE_LATENESS_MS = 6 * 3600_000;
const MAX_ARGS = 64;
const MAX_ARG_LEN = 4096;

export interface ScheduledJobSpec {
	agentId: string;
	scriptPath: string;
	args: string[];
	notifyAgentId?: string;
	notifySubject?: string;
}

/** The fields ingestion owns on a `scheduled_messages` document. */
export interface ScheduleDoc {
	_id?: unknown;
	missionId: string;
	origin: typeof SCHEDULE_ORIGIN;
	label: string;
	kind: "message" | "job";
	to?: string[];
	subject?: string;
	body?: string;
	jobSpec?: ScheduledJobSpec;
	cron: string;
	specHash: string;
	/** The agent that owns the file (uid attribution), never a field from the file. */
	createdBy: string;
	deliverAt: Date;
	status: "pending" | "delivering" | "delivered" | "cancelled" | "failed";
	deliveryAttempts: number;
	pendingFire?: { dueAt: Date; requestedAt: Date };
	lastFiredAt?: Date;
	createdAt: Date;
	updatedAt: Date;
	cancelledAt?: Date;
}

export interface ScheduleIngestDeps {
	sharedDir: string;
	missionId: string;
	db: Db;
	teamConfig: TeamConfig;
	/** Owner uid → agentId, as the job runner uses it. */
	uidToAgentId: ReadonlyMap<number, string>;
	daemonUid: number;
	anomalyRecorder: AnomalyRecorder;
	now?: () => Date;
	/** Injected by tests to simulate file ownership. */
	ownerUidOf?: (path: string) => number;
	/** Receives each refusal once per distinct reason (defaults to console.error). */
	onRejected?: (file: string, reason: string) => void;
	log?: (line: string) => void;
}

export interface IngestSummary {
	imported: string[];
	updated: string[];
	cancelled: number;
	rejected: Array<{ file: string; reason: string }>;
}

export interface FireSummary {
	fired: string[];
	skippedLate: string[];
}

/** Partial unique index so two ticks (or a crash mid-insert) cannot create two documents for one label. */
export async function ensureScheduleIndexes(db: Db): Promise<void> {
	await db.collection("scheduled_messages").createIndex(
		{ missionId: 1, origin: 1, label: 1 },
		{
			unique: true,
			partialFilterExpression: { origin: { $exists: true } },
			name: "shared_schedule_label",
		},
	);
}

/** Deterministic job id for one fire of one label: the same occurrence always maps to the same id. */
export function jobFireId(label: string, dueAt: Date): string {
	return `${label.replace(/\./g, "_")}-${dueAt.getTime()}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type ParsedMessage = {
	kind: "message";
	to: string[];
	subject: string;
	body: string;
	cron: string;
	deliverAt: Date;
};
type ParsedJob = {
	kind: "job";
	jobSpec: ScheduledJobSpec;
	cron: string;
	deliverAt: Date;
};
type Parsed = ParsedMessage | ParsedJob;
type Rejected = { reject: string };

function isStringArray(v: unknown, max: number, maxLen: number): v is string[] {
	return (
		Array.isArray(v) &&
		v.length <= max &&
		v.every((s) => typeof s === "string" && s.length <= maxLen)
	);
}

function validateJobSpec(
	js: unknown,
	owner: string,
	roster: ReadonlySet<string>,
): ScheduledJobSpec | Rejected {
	if (!js || typeof js !== "object" || Array.isArray(js)) {
		return { reject: "jobSpec must be an object" };
	}
	const j = js as Record<string, unknown>;
	if (j.agentId !== owner) {
		return {
			reject: `jobSpec.agentId "${String(j.agentId)}" but the file is owned by "${owner}" — a scheduled job runs as whoever created the schedule`,
		};
	}
	if (typeof j.scriptPath !== "string" || !isAbsolute(j.scriptPath)) {
		return { reject: "jobSpec.scriptPath must be an absolute path" };
	}
	const args = j.args ?? [];
	if (!isStringArray(args, MAX_ARGS, MAX_ARG_LEN)) {
		return {
			reject: `jobSpec.args must be up to ${MAX_ARGS} strings of at most ${MAX_ARG_LEN} characters`,
		};
	}
	const spec: ScheduledJobSpec = {
		agentId: owner,
		scriptPath: j.scriptPath,
		args,
	};
	if (j.notifyAgentId !== undefined) {
		const notifyAgentId = String(j.notifyAgentId);
		if (!roster.has(notifyAgentId)) {
			return {
				reject: `jobSpec.notifyAgentId "${notifyAgentId}" is not an agent of this mission`,
			};
		}
		spec.notifyAgentId = notifyAgentId;
	}
	if (j.notifySubject !== undefined) {
		const notifySubject = String(j.notifySubject);
		if (notifySubject.length > 200) {
			return { reject: "jobSpec.notifySubject must be at most 200 characters" };
		}
		spec.notifySubject = notifySubject;
	}
	return spec;
}

function validateMessageFields(
	spec: Record<string, unknown>,
	roster: ReadonlySet<string>,
): Omit<ParsedMessage, "kind" | "cron" | "deliverAt"> | Rejected {
	if (!isStringArray(spec.to, 20, 128) || spec.to.length === 0) {
		return { reject: "to must name 1–20 recipients" };
	}
	const to = [...new Set(spec.to.map((t) => t.trim()).filter(Boolean))];
	const unknown = to.filter((t) => !roster.has(t));
	if (unknown.length > 0) {
		return {
			reject: `unknown recipient(s) ${unknown.join(", ")} — not agents of this mission`,
		};
	}
	const { subject, body } = spec;
	if (typeof subject !== "string" || !subject.trim() || subject.length > 200) {
		return { reject: "subject must be 1–200 characters" };
	}
	if (typeof body !== "string" || !body.trim() || body.length > 20_000) {
		return { reject: "body must be 1–20000 characters" };
	}
	return { to, subject, body };
}

/**
 * Validate one parsed file against the roster and the author. Returns the
 * sanitised spec (only the fields the platform acts on) or the refusal.
 */
export function validateScheduleSpec(
	raw: unknown,
	label: string,
	owner: string,
	roster: ReadonlySet<string>,
	now: () => Date,
): Parsed | Rejected {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { reject: "not a JSON object" };
	}
	const spec = raw as Record<string, unknown>;
	if (spec.label !== undefined && spec.label !== label) {
		return {
			reject: `label "${String(spec.label)}" does not match the file name "${label}"`,
		};
	}
	if (typeof spec.cron !== "string" || !spec.cron.trim()) {
		return { reject: "cron is required (5-field expression)" };
	}
	const when = resolveDeliverAt(undefined, spec.cron, () => now().getTime());
	if ("error" in when) return { reject: when.error };
	const common = { cron: spec.cron, deliverAt: when.deliverAt };

	if (spec.jobSpec !== undefined) {
		const jobSpec = validateJobSpec(spec.jobSpec, owner, roster);
		if ("reject" in jobSpec) return jobSpec;
		return { kind: "job", jobSpec, ...common };
	}
	const message = validateMessageFields(spec, roster);
	if ("reject" in message) return message;
	return { kind: "message", ...message, ...common };
}

/** Hash of the fields the platform acts on (plus the author), so a whitespace edit does not re-arm. */
function specHashOf(parsed: Parsed, owner: string): string {
	const { deliverAt: _ignored, ...rest } = parsed;
	return createHash("sha256")
		.update(JSON.stringify({ ...rest, createdBy: owner }))
		.digest("hex");
}

/** The agents' schedule directory: daemon-owned, sticky-writable like `shared/jobs/pending` (see `ensureSubmissionDir`). */
export function ensureSchedulesDir(sharedDir: string): string {
	const dir = join(sharedDir, SCHEDULES_DIRNAME);
	mkdirSync(dir, { recursive: true });
	try {
		chmodSync(dir, 0o1777);
	} catch (e) {
		console.error(
			`[daemon:scheduler] Could not make ${dir} writable for agents: ${(e as Error).message}`,
		);
	}
	return dir;
}

// ---------------------------------------------------------------------------
// Ingestor
// ---------------------------------------------------------------------------

interface IngestContext {
	deps: ScheduleIngestDeps;
	now: () => Date;
	log: (line: string) => void;
	col: Collection<ScheduleDoc>;
	roster: ReadonlySet<string>;
	/** file → last reported refusal, so a persistently bad file is reported once, not every minute. */
	reported: Map<string, string>;
	base: { missionId: string; origin: typeof SCHEDULE_ORIGIN };
	/** Set for the duration of one ingest() so refusals also land in its summary. */
	collect?: (file: string, reason: string) => void;
}

function reject(ctx: IngestContext, file: string, reason: string): null {
	if (ctx.reported.get(file) === reason) return null;
	ctx.reported.set(file, reason);
	ctx.collect?.(file, reason);
	(
		ctx.deps.onRejected ??
		((f, r) =>
			console.error(`[daemon:scheduler] Refused schedule file ${f}: ${r}`))
	)(file, reason);
	return null;
}

/** lstat-level refusals shared with the job runner: who wrote it, and is it a plain file. */
function fileOwner(
	ctx: IngestContext,
	dir: string,
	file: string,
): string | null {
	const path = join(dir, file);
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(path);
	} catch {
		return null; // removed between readdir and here
	}
	if (st.isSymbolicLink()) return reject(ctx, file, "symlink");
	if (!st.isFile()) return reject(ctx, file, "not a regular file");
	if (st.nlink > 1) return reject(ctx, file, "hard link");
	if (st.size > MAX_SCHEDULE_FILE_BYTES)
		return reject(ctx, file, "file too large");
	const uid = ctx.deps.ownerUidOf ? ctx.deps.ownerUidOf(path) : st.uid;
	if (uid === ctx.deps.daemonUid) {
		return reject(
			ctx,
			file,
			"owned by the daemon (renamed or planted, not written by an agent)",
		);
	}
	const owner = ctx.deps.uidToAgentId.get(uid);
	if (!owner) {
		return reject(
			ctx,
			file,
			`owner uid ${uid} is not an agent of this mission`,
		);
	}
	return owner;
}

function readScheduleFile(
	ctx: IngestContext,
	dir: string,
	file: string,
): { label: string; owner: string; parsed: Parsed } | null {
	const stem = file.replace(/\.json$/, "");
	if (!SCHEDULE_LABEL_RE.test(stem)) {
		return reject(
			ctx,
			file,
			"file name is not a schedule label (lower-case slug)",
		);
	}
	const owner = fileOwner(ctx, dir, file);
	if (!owner) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(
			readInside(dir, file, {
				maxBytes: MAX_SCHEDULE_FILE_BYTES,
			}).bytes.toString("utf8"),
		);
	} catch (e) {
		return reject(
			ctx,
			file,
			`unreadable or malformed JSON: ${(e as Error).message}`,
		);
	}
	const parsed = validateScheduleSpec(raw, stem, owner, ctx.roster, ctx.now);
	if ("reject" in parsed) return reject(ctx, file, parsed.reject);
	ctx.reported.delete(file);
	return { label: stem, owner, parsed };
}

/** The document fields one parsed file maps to (everything but the arming state). */
function docFields(label: string, owner: string, parsed: Parsed) {
	const common = {
		kind: parsed.kind,
		cron: parsed.cron,
		specHash: specHashOf(parsed, owner),
		createdBy: owner,
	};
	if (parsed.kind === "message") {
		return {
			...common,
			to: parsed.to,
			subject: parsed.subject,
			body: parsed.body,
		};
	}
	return {
		...common,
		jobSpec: parsed.jobSpec,
		// Mail-shaped fields so a generic reader (cockpit, copilot listing)
		// still has something to show.
		to: [parsed.jobSpec.agentId],
		subject: `Scheduled job: ${label}`,
		body: `Runs ${parsed.jobSpec.scriptPath} as ${parsed.jobSpec.agentId} on cron ${parsed.cron}.`,
	};
}

/** Insert on first sight, re-arm on change or after a cancel; returns what happened. */
async function upsertSchedule(
	ctx: IngestContext,
	label: string,
	owner: string,
	parsed: Parsed,
): Promise<"imported" | "updated" | "unchanged"> {
	const fields = docFields(label, owner, parsed);
	const at = ctx.now();
	const filter = { ...ctx.base, label };
	const existing = await ctx.col.findOne(filter);
	if (!existing) {
		const r = await ctx.col.updateOne(
			filter,
			{
				$setOnInsert: {
					...filter,
					...fields,
					deliverAt: parsed.deliverAt,
					status: "pending",
					deliveryAttempts: 0,
					createdAt: at,
					updatedAt: at,
				},
			},
			{ upsert: true },
		);
		return r.upsertedCount === 1 ? "imported" : "unchanged";
	}
	const rearm =
		existing.specHash !== fields.specHash ||
		existing.status === "cancelled" ||
		existing.status === "failed" ||
		existing.status === "delivered";
	if (!rearm) return "unchanged";
	await ctx.col.updateOne(filter, {
		$set: {
			...fields,
			deliverAt: parsed.deliverAt,
			status: "pending",
			deliveryAttempts: 0,
			updatedAt: at,
		},
		$unset: { pendingFire: "", claimedAt: "", cancelledAt: "" },
	});
	return "updated";
}

async function ingestSchedules(ctx: IngestContext): Promise<IngestSummary> {
	const summary: IngestSummary = {
		imported: [],
		updated: [],
		cancelled: 0,
		rejected: [],
	};
	const dir = ensureSchedulesDir(ctx.deps.sharedDir);
	ctx.collect = (file, reason) => summary.rejected.push({ file, reason });
	const seen: string[] = [];
	try {
		for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
			const read = readScheduleFile(ctx, dir, file);
			if (!read) continue;
			seen.push(read.label);
			const outcome = await upsertSchedule(
				ctx,
				read.label,
				read.owner,
				read.parsed,
			);
			if (outcome === "unchanged") continue;
			summary[outcome].push(read.label);
			ctx.log(
				`[daemon:scheduler] Schedule ${outcome}: ${read.label} → next at ${read.parsed.deliverAt.toISOString()}`,
			);
		}
		const gone = await ctx.col.updateMany(
			{ ...ctx.base, status: "pending", label: { $nin: seen } },
			{
				$set: {
					status: "cancelled",
					cancelledAt: ctx.now(),
					updatedAt: ctx.now(),
				},
			},
		);
		summary.cancelled = gone.modifiedCount ?? 0;
		if (summary.cancelled > 0) {
			ctx.log(
				`[daemon:scheduler] Cancelled ${summary.cancelled} schedule(s) whose file was removed`,
			);
		}
	} finally {
		ctx.collect = undefined;
	}
	return summary;
}

function alreadyFired(sharedDir: string, jobId: string): boolean {
	const dirs = jobDirs(sharedDir);
	return [dirs.queue, dirs.running, dirs.status, dirs.failed].some((d) =>
		existsSync(join(d, `${jobId}.json`)),
	);
}

async function claimJobFires(ctx: IngestContext): Promise<FireSummary> {
	const summary: FireSummary = { fired: [], skippedLate: [] };
	const docs = await ctx.col
		.find({ ...ctx.base, kind: "job", pendingFire: { $exists: true } })
		.toArray();
	for (const doc of docs) {
		if (!doc.pendingFire || !doc.jobSpec) continue;
		const dueAt = new Date(doc.pendingFire.dueAt);
		const at = ctx.now();
		const lateMs = at.getTime() - dueAt.getTime();
		const ack = () =>
			ctx.col.updateOne(
				{ _id: doc._id, "pendingFire.dueAt": dueAt },
				{ $unset: { pendingFire: "" }, $set: { lastFiredAt: at } },
			);
		if (lateMs > MAX_JOB_FIRE_LATENESS_MS) {
			await ctx.deps.anomalyRecorder.record({
				missionId: ctx.deps.missionId,
				category: "scheduling-failure",
				severity: "soft",
				message: `Scheduled job "${doc.label}" was due at ${dueAt.toISOString()} but the mission was unavailable for ${(lateMs / 3600_000).toFixed(1)} h; that occurrence was skipped (its next cron fire runs normally).`,
			});
			await ack();
			summary.skippedLate.push(doc.label);
			continue;
		}
		const jobId = jobFireId(doc.label, dueAt);
		if (!alreadyFired(ctx.deps.sharedDir, jobId)) {
			const spec: JobSpec = { id: jobId, ...doc.jobSpec };
			try {
				enqueuePrivateJob(jobDirs(ctx.deps.sharedDir), spec);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			}
		}
		await ack();
		summary.fired.push(doc.label);
		ctx.log(
			`[daemon:scheduler] Fired job schedule "${doc.label}" → job ${jobId}`,
		);
	}
	return summary;
}

export function createScheduleIngestor(deps: ScheduleIngestDeps): {
	ingest(): Promise<IngestSummary>;
	claimJobFires(): Promise<FireSummary>;
} {
	const ctx: IngestContext = {
		deps,
		now: deps.now ?? (() => new Date()),
		log: deps.log ?? ((line: string) => console.log(line)),
		col: deps.db.collection("scheduled_messages"),
		roster: new Set<string>([
			...deps.teamConfig.agents.map((a) => a.id),
			"user",
			MISSION_COPILOT_AGENT_ID,
		]),
		reported: new Map(),
		base: { missionId: deps.missionId, origin: SCHEDULE_ORIGIN },
	};
	return {
		ingest: () => ingestSchedules(ctx),
		claimJobFires: () => claimJobFires(ctx),
	};
}
