/**
 * schedule-ingest.ts — `shared/schedules/*.json` → `scheduled_messages`
 * (ADR-0033 §3). Real tmpdir; Mongo faked in memory; file ownership injected.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TeamConfig } from "@magi/agent-config";
import type { Db } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnomalyRecorder, MissionAnomaly } from "../src/anomaly.js";
import { jobDirs } from "../src/job-runner.js";
import {
	createScheduleIngestor,
	jobFireId,
	MAX_JOB_FIRE_LATENESS_MS,
	SCHEDULE_ORIGIN,
	type ScheduleDoc,
	type ScheduleIngestDeps,
} from "../src/schedule-ingest.js";

const MISSION = "m1";
const UID_A1 = 1001;
const UID_A2 = 1002;
const DAEMON_UID = 999;
const NOW = new Date("2026-10-17T12:00:00Z");

// ---------------------------------------------------------------------------
// In-memory collection: equality, dotted paths, $in/$nin/$exists, $set/$unset/
// $setOnInsert with upsert — exactly the surface schedule-ingest.ts uses.
// ---------------------------------------------------------------------------

type Doc = Record<string, unknown>;

function getPath(doc: Doc, path: string): unknown {
	return path
		.split(".")
		.reduce<unknown>(
			(o, k) => (o && typeof o === "object" ? (o as Doc)[k] : undefined),
			doc,
		);
}

function same(a: unknown, b: unknown): boolean {
	if (a instanceof Date && b instanceof Date)
		return a.getTime() === b.getTime();
	return a === b;
}

function matches(doc: Doc, filter: Doc): boolean {
	return Object.entries(filter).every(([k, v]) => {
		const actual = getPath(doc, k);
		if (v && typeof v === "object" && !(v instanceof Date)) {
			const op = v as Doc;
			if ("$exists" in op) return (actual !== undefined) === op.$exists;
			if ("$in" in op)
				return (op.$in as unknown[]).some((x) => same(x, actual));
			if ("$nin" in op)
				return !(op.$nin as unknown[]).some((x) => same(x, actual));
		}
		return same(actual, v);
	});
}

function applyUpdate(doc: Doc, update: Doc): void {
	for (const [k, v] of Object.entries((update.$set as Doc) ?? {})) doc[k] = v;
	for (const k of Object.keys((update.$unset as Doc) ?? {})) delete doc[k];
}

function fakeDb() {
	const docs: Doc[] = [];
	let seq = 0;
	const collection = {
		async createIndex() {
			return "ok";
		},
		async findOne(filter: Doc) {
			return docs.find((d) => matches(d, filter)) ?? null;
		},
		find(filter: Doc) {
			return {
				toArray: async () => docs.filter((d) => matches(d, filter)),
			};
		},
		async updateOne(filter: Doc, update: Doc, opts?: { upsert?: boolean }) {
			const doc = docs.find((d) => matches(d, filter));
			if (doc) {
				applyUpdate(doc, update);
				return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
			}
			if (opts?.upsert) {
				const created: Doc = { _id: `id${++seq}` };
				for (const [k, v] of Object.entries(filter)) {
					if (!(v && typeof v === "object" && !(v instanceof Date)))
						created[k] = v;
				}
				for (const [k, v] of Object.entries((update.$setOnInsert as Doc) ?? {}))
					created[k] = v;
				applyUpdate(created, update);
				docs.push(created);
				return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
			}
			return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
		},
		async updateMany(filter: Doc, update: Doc) {
			let n = 0;
			for (const d of docs) {
				if (matches(d, filter)) {
					applyUpdate(d, update);
					n++;
				}
			}
			return { matchedCount: n, modifiedCount: n };
		},
	};
	const db = { collection: () => collection } as unknown as Db;
	return { db, docs: docs as unknown as ScheduleDoc[] };
}

// ---------------------------------------------------------------------------

let base: string;
let sharedDir: string;
let schedulesDir: string;
let owners: Map<string, number>;
let anomalies: Array<Omit<MissionAnomaly, "createdAt">>;

const teamConfig = {
	agents: [
		{ id: "a1", linuxUser: "magi-w1" },
		{ id: "a2", linuxUser: "magi-w2" },
	],
} as unknown as TeamConfig;

function makeDeps(
	db: Db,
	over: Partial<ScheduleIngestDeps> = {},
): ScheduleIngestDeps & { rejected: string[]; lines: string[] } {
	const rejected: string[] = [];
	const lines: string[] = [];
	const recorder: AnomalyRecorder = {
		record: async (a) => {
			anomalies.push(a);
		},
	} as unknown as AnomalyRecorder;
	return {
		sharedDir,
		missionId: MISSION,
		db,
		teamConfig,
		uidToAgentId: new Map([
			[UID_A1, "a1"],
			[UID_A2, "a2"],
		]),
		daemonUid: DAEMON_UID,
		anomalyRecorder: recorder,
		now: () => NOW,
		ownerUidOf: (p) => owners.get(p) ?? DAEMON_UID,
		onRejected: (f, r) => rejected.push(`${f}: ${r}`),
		log: (l) => lines.push(l),
		rejected,
		lines,
		...over,
	};
}

function writeSchedule(label: string, spec: unknown, uid: number): string {
	mkdirSync(schedulesDir, { recursive: true });
	const path = join(schedulesDir, `${label}.json`);
	writeFileSync(path, JSON.stringify(spec, null, 2));
	owners.set(path, uid);
	return path;
}

const dailyBrief = {
	label: "daily-brief",
	to: ["a1"],
	cron: "0 6 * * 1-5",
	subject: "[task] Daily cycle",
	body: "Begin.",
};

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "magi-sched-"));
	sharedDir = join(base, "missions", MISSION, "shared");
	mkdirSync(sharedDir, { recursive: true });
	schedulesDir = join(sharedDir, "schedules");
	owners = new Map();
	anomalies = [];
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("ingest — message schedules", () => {
	it("imports a file once, armed at the cron's next occurrence, and leaves it alone on the next tick", async () => {
		const { db, docs } = fakeDb();
		const deps = makeDeps(db);
		writeSchedule("daily-brief", dailyBrief, UID_A1);
		const ing = createScheduleIngestor(deps);

		const first = await ing.ingest();
		expect(first.imported).toEqual(["daily-brief"]);
		expect(docs).toHaveLength(1);
		const doc = docs[0];
		expect(doc).toMatchObject({
			missionId: MISSION,
			origin: SCHEDULE_ORIGIN,
			label: "daily-brief",
			kind: "message",
			to: ["a1"],
			subject: "[task] Daily cycle",
			cron: "0 6 * * 1-5",
			createdBy: "a1",
			status: "pending",
			deliveryAttempts: 0,
		});
		// Mon–Fri 06:00 after 2026-10-17 12:00 (a Saturday) → Monday 19th.
		expect(doc.deliverAt.toISOString()).toBe("2026-10-19T06:00:00.000Z");
		expect(deps.lines[0]).toBe(
			"[daemon:scheduler] Schedule imported: daily-brief → next at 2026-10-19T06:00:00.000Z",
		);

		const again = await ing.ingest();
		expect(again.imported).toEqual([]);
		expect(again.updated).toEqual([]);
		expect(docs).toHaveLength(1);
		expect(docs[0].deliverAt.toISOString()).toBe("2026-10-19T06:00:00.000Z");
	});

	it("re-arms when the cron changes, not when only whitespace changes", async () => {
		const { db, docs } = fakeDb();
		const ing = createScheduleIngestor(makeDeps(db));
		const path = writeSchedule("daily-brief", dailyBrief, UID_A1);
		await ing.ingest();
		docs[0].deliverAt = new Date("2099-01-01T00:00:00Z"); // pretend the control plane re-armed it

		writeFileSync(path, `${JSON.stringify(dailyBrief)}\n\n`);
		expect((await ing.ingest()).updated).toEqual([]);
		expect(docs[0].deliverAt.toISOString()).toBe("2099-01-01T00:00:00.000Z");

		writeFileSync(path, JSON.stringify({ ...dailyBrief, cron: "0 7 * * *" }));
		expect((await ing.ingest()).updated).toEqual(["daily-brief"]);
		expect(docs[0].cron).toBe("0 7 * * *");
		expect(docs[0].deliverAt.toISOString()).toBe("2026-10-18T07:00:00.000Z");
		expect(docs[0].status).toBe("pending");
	});

	it("cancels a pending schedule whose file was removed and re-arms it when the file comes back", async () => {
		const { db, docs } = fakeDb();
		const ing = createScheduleIngestor(makeDeps(db));
		const path = writeSchedule("daily-brief", dailyBrief, UID_A1);
		await ing.ingest();

		unlinkSync(path);
		const r = await ing.ingest();
		expect(r.cancelled).toBe(1);
		expect(docs[0].status).toBe("cancelled");

		writeSchedule("daily-brief", dailyBrief, UID_A1);
		expect((await ing.ingest()).updated).toEqual(["daily-brief"]);
		expect(docs[0].status).toBe("pending");
		expect(docs).toHaveLength(1);
	});

	it("never touches a document the copilot created (no origin)", async () => {
		const { db, docs } = fakeDb();
		(docs as unknown as Doc[]).push({
			_id: "copilot",
			missionId: MISSION,
			to: ["a1"],
			subject: "x",
			body: "y",
			status: "pending",
			deliverAt: NOW,
		});
		const ing = createScheduleIngestor(makeDeps(db));
		await ing.ingest();
		expect(docs[0].status).toBe("pending");
	});
});

describe("ingest — refusals (uid attribution and validation)", () => {
	async function ingestOne(
		label: string,
		spec: unknown,
		uid: number,
	): Promise<{ rejected: string[]; docs: ScheduleDoc[] }> {
		const { db, docs } = fakeDb();
		const deps = makeDeps(db);
		writeSchedule(label, spec, uid);
		await createScheduleIngestor(deps).ingest();
		return { rejected: deps.rejected, docs };
	}

	it("refuses a job schedule naming an agent other than the file's owner", async () => {
		const { rejected, docs } = await ingestOne(
			"nightly",
			{
				cron: "0 2 * * *",
				jobSpec: { agentId: "a2", scriptPath: "/x/run.py", args: [] },
			},
			UID_A1,
		);
		expect(docs).toHaveLength(0);
		expect(rejected[0]).toMatch(/owned by "a1"/);
	});

	it("ignores linuxUser in the file and attributes the job to the owner", async () => {
		const { docs } = await ingestOne(
			"nightly",
			{
				cron: "0 2 * * *",
				jobSpec: {
					agentId: "a1",
					linuxUser: "root",
					scriptPath: "/x/run.py",
					args: ["--full"],
					notifySubject: "done",
				},
			},
			UID_A1,
		);
		expect(docs).toHaveLength(1);
		expect(docs[0].kind).toBe("job");
		expect(docs[0].jobSpec).toEqual({
			agentId: "a1",
			scriptPath: "/x/run.py",
			args: ["--full"],
			notifySubject: "done",
		});
		expect(docs[0].createdBy).toBe("a1");
	});

	it("refuses a symlink, a daemon-owned file, an unknown owner and a bad label", async () => {
		const { db, docs } = fakeDb();
		const deps = makeDeps(db);
		mkdirSync(schedulesDir, { recursive: true });
		const real = join(base, "outside.json");
		writeFileSync(real, JSON.stringify(dailyBrief));
		symlinkSync(real, join(schedulesDir, "linked.json"));
		writeSchedule("planted", dailyBrief, DAEMON_UID);
		writeSchedule("stranger", dailyBrief, 4242);
		writeSchedule("Bad Label", dailyBrief, UID_A1);
		await createScheduleIngestor(deps).ingest();
		expect(docs).toHaveLength(0);
		expect(deps.rejected.join("\n")).toMatch(/linked\.json: symlink/);
		expect(deps.rejected.join("\n")).toMatch(
			/planted\.json: owned by the daemon/,
		);
		expect(deps.rejected.join("\n")).toMatch(/stranger\.json: owner uid 4242/);
		expect(deps.rejected.join("\n")).toMatch(/Bad Label\.json: file name/);
	});

	it("refuses unknown recipients, a label that disagrees with the file name and a sub-5-minute cron", async () => {
		expect(
			(
				await ingestOne(
					"a",
					{ ...dailyBrief, label: "a", to: ["nobody"] },
					UID_A1,
				)
			).rejected[0],
		).toMatch(/unknown recipient/);
		expect(
			(await ingestOne("a", { ...dailyBrief, label: "other" }, UID_A1))
				.rejected[0],
		).toMatch(/does not match the file name/);
		expect(
			(
				await ingestOne(
					"a",
					{ ...dailyBrief, label: "a", cron: "* * * * *" },
					UID_A1,
				)
			).rejected[0],
		).toMatch(/more often than every 5 minutes/);
	});

	it("reports a persistently bad file once per reason, not every tick", async () => {
		const { db } = fakeDb();
		const deps = makeDeps(db);
		writeSchedule("broken", { cron: "nope" }, UID_A1);
		const ing = createScheduleIngestor(deps);
		await ing.ingest();
		await ing.ingest();
		await ing.ingest();
		expect(deps.rejected).toHaveLength(1);
	});
});

describe("claimJobFires", () => {
	async function seedJob(
		db: Db,
		docs: ScheduleDoc[],
		dueAt: Date,
	): Promise<ReturnType<typeof createScheduleIngestor>> {
		const deps = makeDeps(db);
		writeSchedule(
			"nightly.refresh",
			{
				cron: "0 2 * * *",
				jobSpec: {
					agentId: "a1",
					scriptPath: "/x/run.py",
					args: ["--full"],
					notifyAgentId: "a2",
					notifySubject: "refresh done",
				},
			},
			UID_A1,
		);
		const ing = createScheduleIngestor(deps);
		await ing.ingest();
		// What the control plane does when the entry comes due.
		docs[0].pendingFire = { dueAt, requestedAt: NOW };
		return ing;
	}

	it("turns a pendingFire into exactly one private-queue job and acknowledges it", async () => {
		const { db, docs } = fakeDb();
		const dueAt = new Date(NOW.getTime() - 10 * 60_000);
		const ing = await seedJob(db, docs, dueAt);

		const r = await ing.claimJobFires();
		expect(r.fired).toEqual(["nightly.refresh"]);
		const dirs = jobDirs(sharedDir);
		const id = jobFireId("nightly.refresh", dueAt);
		expect(id).toBe(`nightly_refresh-${dueAt.getTime()}`);
		const files = readdirSync(dirs.queue);
		expect(files).toEqual([`${id}.json`]);
		const spec = JSON.parse(readFileSync(join(dirs.queue, files[0]), "utf8"));
		expect(spec).toEqual({
			id,
			agentId: "a1",
			scriptPath: "/x/run.py",
			args: ["--full"],
			notifyAgentId: "a2",
			notifySubject: "refresh done",
		});
		expect(docs[0].pendingFire).toBeUndefined();
		expect(docs[0].lastFiredAt).toEqual(NOW);

		// Crash between enqueue and acknowledge: the stamp is still there, the
		// file too — the re-claim must not produce a second job.
		docs[0].pendingFire = { dueAt, requestedAt: NOW };
		await ing.claimJobFires();
		expect(readdirSync(dirs.queue)).toEqual([`${id}.json`]);
		expect(docs[0].pendingFire).toBeUndefined();

		// Already consumed by the job runner (moved on to status/): still no second job.
		unlinkSync(join(dirs.queue, `${id}.json`));
		writeFileSync(join(dirs.status, `${id}.json`), "{}");
		docs[0].pendingFire = { dueAt, requestedAt: NOW };
		await ing.claimJobFires();
		expect(existsSync(join(dirs.queue, `${id}.json`))).toBe(false);
	});

	it("skips a fire the mission slept through for more than the lateness cap and records an anomaly", async () => {
		const { db, docs } = fakeDb();
		const dueAt = new Date(NOW.getTime() - MAX_JOB_FIRE_LATENESS_MS - 60_000);
		const ing = await seedJob(db, docs, dueAt);
		const r = await ing.claimJobFires();
		expect(r.skippedLate).toEqual(["nightly.refresh"]);
		expect(r.fired).toEqual([]);
		expect(existsSync(jobDirs(sharedDir).queue)).toBe(false);
		expect(docs[0].pendingFire).toBeUndefined();
		expect(anomalies).toHaveLength(1);
		expect(anomalies[0]).toMatchObject({
			category: "scheduling-failure",
			severity: "soft",
		});
		expect(anomalies[0].message).toContain("nightly.refresh");
	});
});
