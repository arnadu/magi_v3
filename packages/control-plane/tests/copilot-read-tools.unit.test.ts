/**
 * The control-plane copilot's read tools, against a fake database: what each
 * reports, and that each sees only the caller's own missions. Live Fly and the
 * daemon are covered by copilot-read-log-fallback.unit.test.ts and the
 * integration tests.
 */
import { describe, expect, it, vi } from "vitest";
import { createReadTools } from "../src/copilot-read-tools.js";
import { volumeExists } from "../src/fly-machines.js";
import { type Doc, fakeDb } from "./support/fake-db.js";

vi.mock("../src/fly-machines.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/fly-machines.js")>()),
	volumeExists: vi.fn(),
}));

const at = new Date("2026-11-23T00:00:00Z");
const mission = (over: Doc = {}): Doc => ({
	missionId: "news",
	userId: "u1",
	name: "News",
	status: "running",
	createdAt: at,
	updatedAt: at,
	...over,
});

function tools(data: Record<string, Doc[]>, userId = "u1") {
	const { db } = fakeDb({
		missions: [],
		mailbox: [],
		machineSegments: [],
		missionResources: [],
		scheduled_messages: [],
		...data,
	});
	return createReadTools({
		db,
		userId,
		pushEvent: () => {},
		pending: {} as never,
	});
}

const text = (r: { content: Array<{ type: string; text?: string }> }) =>
	r.content.map((c) => c.text ?? "").join("");

describe("ListMissions", () => {
	it("lists the caller's missions only, and says when there are none", async () => {
		const t = tools({
			missions: [mission(), mission({ missionId: "theirs", userId: "u2" })],
		});
		const out = text(await t.listMissions.execute("t", {}));
		expect(out).toContain("news | News | running");
		expect(out).not.toContain("theirs");
		expect(text(await tools({}).listMissions.execute("t", {}))).toBe(
			"(no missions)",
		);
	});
});

describe("ReadMissionMailbox", () => {
	it("reads the mission's messages, says when it is empty, refuses another user's mission", async () => {
		const msg = {
			missionId: "news",
			from: "editor-in-chief",
			to: ["user"],
			subject: "Vol. 10 closed",
			body: "Standing by.",
			timestamp: at,
		};
		const t = tools({ missions: [mission()], mailbox: [msg] });
		expect(
			text(await t.readMissionMailbox.execute("t", { missionId: "news" })),
		).toContain("editor-in-chief → user | Vol. 10 closed");
		const empty = tools({ missions: [mission()] });
		expect(
			text(
				await empty.readMissionMailbox.execute("t", {
					missionId: "news",
					limit: 5,
				}),
			),
		).toBe("(mailbox empty)");
		const other = tools({ missions: [mission()], mailbox: [msg] }, "u2");
		expect(
			(await other.readMissionMailbox.execute("t", { missionId: "news" }))
				.isError,
		).toBe(true);
	});
});

describe("ListSchedule", () => {
	const sched = (missionId: string): Doc => ({
		_id: `s-${missionId}`,
		missionId,
		status: "pending",
		deliverAt: at,
		subject: `brief ${missionId}`,
	});

	it("lists one mission's or all the caller's schedules, never another user's", async () => {
		const t = tools({
			missions: [mission(), mission({ missionId: "theirs", userId: "u2" })],
			scheduled_messages: [sched("news"), sched("theirs")],
		});
		const all = text(await t.listSchedule.execute("t", {}));
		expect(all).toContain("brief news");
		expect(all).not.toContain("brief theirs");
		expect(
			text(await t.listSchedule.execute("t", { missionId: "news" })),
		).toContain("brief news");
		expect(
			(await t.listSchedule.execute("t", { missionId: "theirs" })).isError,
		).toBe(true);
		expect(
			text(
				await tools({ missions: [mission()] }).listSchedule.execute("t", {}),
			),
		).toBe("(no scheduled messages)");
	});
});

describe("GetMissionStatus", () => {
	const status = async (over: Doc, data: Record<string, Doc[]> = {}) =>
		text(
			await tools({
				missions: [mission(over)],
				...data,
			}).getMissionStatus.execute("t", {
				missionId: "news",
			}),
		);

	it("refuses another user's mission", async () => {
		const r = await tools(
			{ missions: [mission()] },
			"u2",
		).getMissionStatus.execute("t", {
			missionId: "news",
		});
		expect(r.isError).toBe(true);
	});

	it("reports the tier, an upgrade's expiry, the disk sample and the volume as checked on Fly", async () => {
		vi.mocked(volumeExists).mockResolvedValueOnce(true);
		const out = await status(
			{
				volumeId: "vol_1",
				upgrade: { cpuKind: "shared", cpus: 2, memoryMb: 4096, expiresAt: at },
			},
			{
				missionResources: [
					{
						missionId: "news",
						diskUsedBytes: 1024 ** 3,
						diskTotalBytes: 10 * 1024 ** 3,
					},
				],
			},
		);
		expect(out).toContain(
			"tier:      shared, 2 CPUs, 4096 MB (upgraded, expires 2026-11-23T00:00:00.000Z)",
		);
		expect(out).toContain("disk:      1.0 / 10.0 GB (sample age unknown)");
		expect(out).toContain("volumeId:  vol_1 (verified on Fly)");
	});

	it("says when the volume is not on Fly, cannot be checked, or is not on record", async () => {
		vi.mocked(volumeExists).mockResolvedValueOnce(false);
		expect(await status({ volumeId: "vol_1" })).toContain("NOT FOUND on Fly");
		vi.mocked(volumeExists).mockRejectedValueOnce(new Error("Fly API 503"));
		expect(await status({ volumeId: "vol_1" })).toContain(
			"could not verify: Fly API 503",
		);
		expect(await status({})).toContain("volume:    (no volumeId on record)");
		expect(
			await status({ volumeId: "vol_l", machineId: "local-news" }),
		).toContain("local execution");
	});
});
