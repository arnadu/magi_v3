import { verifyAppTicket } from "@magi/agent-config";
import { describe, expect, it, vi } from "vitest";
import { openApp } from "../src/apps-host/open.js";
import { assignSlot, NoFreeSlotError } from "../src/apps-host/slots.js";
import { type Doc, fakeDb } from "./support/fake-db.js";

const CAP = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-11-21T12:00:00Z");
const app = (over: Doc = {}): Doc => ({
	missionId: "m1",
	name: "dash",
	owner: "analyst",
	capability: CAP,
	status: "running",
	restarts: [],
	...over,
});

describe("assignSlot", () => {
	it("gives an app the first free slot, and keeps it on the next open", async () => {
		const { db, data } = fakeDb({
			missionApps: [app({ name: "other", slot: 20000 }), app()],
		});
		const col = db.collection("missionApps") as never;
		expect(await assignSlot(col, { missionId: "m1", name: "dash" }, NOW)).toBe(
			20001,
		);
		const later = new Date(NOW.getTime() + 60_000);
		expect(
			await assignSlot(
				col,
				{ missionId: "m1", name: "dash", slot: 20001 },
				later,
			),
		).toBe(20001);
		expect(data.missionApps.find((d) => d.name === "dash")?.slotUsedAt).toEqual(
			later,
		);
	});

	it("when every slot is held, takes the one unused longest past a session's life", async () => {
		const held = Array.from({ length: 100 }, (_, i) =>
			app({
				missionId: `m${i}`,
				name: `a${i}`,
				slot: 20000 + i,
				slotUsedAt: new Date(NOW.getTime() - (i === 42 ? 13 : 1) * 3_600_000),
			}),
		);
		const { db, data } = fakeDb({
			missionApps: [...held, app({ missionId: "new", name: "x" })],
		});
		const col = db.collection("missionApps") as never;
		expect(await assignSlot(col, { missionId: "new", name: "x" }, NOW)).toBe(
			20042,
		);
		expect(
			data.missionApps.find((d) => d.name === "a42")?.slot,
		).toBeUndefined();
	});

	it("refuses when every slot was used within a session's life", async () => {
		const held = Array.from({ length: 100 }, (_, i) =>
			app({
				missionId: `m${i}`,
				name: `a${i}`,
				slot: 20000 + i,
				slotUsedAt: NOW,
			}),
		);
		const { db } = fakeDb({
			missionApps: [...held, app({ missionId: "new", name: "x" })],
		});
		await expect(
			assignSlot(
				db.collection("missionApps") as never,
				{ missionId: "new", name: "x" },
				NOW,
			),
		).rejects.toThrow(NoFreeSlotError);
	});
});

describe("openApp (app.open, the control plane's part)", () => {
	const base = (
		missionApps: Doc[],
		missions: Doc[] = [
			{
				missionId: "m1",
				userId: "u1",
				status: "running",
				privateIp: "fdaa::2",
			},
		],
	) => {
		const f = fakeDb({ missionApps, missions });
		return {
			...f,
			deps: {
				db: f.db,
				ticketKey: "tk",
				appsHostUrl: "https://magi-apps-dev.fly.dev",
				startApp: vi.fn(async () => {
					const a = f.data.missionApps[0];
					a.status = "starting";
					return { ok: true, message: "starting" };
				}),
				sleep: async () => {
					const a = f.data.missionApps[0];
					if (a.status === "starting") a.status = "running";
				},
			},
		};
	};

	it("returns a ticket URL on the app's slot, for the mission's owner only", async () => {
		const { deps } = base([app()]);
		const r = await openApp(
			deps,
			{ userId: "u1", isAdmin: false },
			{ missionId: "m1", name: "dash" },
		);
		if (!r.ok) throw new Error(r.message);
		expect(r.link).toBe(`https://magi-apps-dev.fly.dev:20000/a/${CAP}/`);
		const ticket = verifyAppTicket(r.url.split("/t/")[1], "tk");
		expect(ticket).toMatchObject({
			userId: "u1",
			missionId: "m1",
			capability: CAP,
			slot: 20000,
			machine: "fdaa::2",
		});
		expect(
			await openApp(
				deps,
				{ userId: "u2", isAdmin: false },
				{ missionId: "m1", name: "dash" },
			),
		).toMatchObject({ ok: false, status: 404 });
		expect(
			await openApp(
				deps,
				{ userId: "u2", isAdmin: false },
				{ capability: CAP },
			),
		).toMatchObject({ ok: false, status: 404 });
	});

	it("starts a stopped app and waits for it to answer", async () => {
		const { deps } = base([app({ status: "stopped" })]);
		const r = await openApp(
			deps,
			{ userId: "u1", isAdmin: false },
			{ capability: CAP },
		);
		expect(deps.startApp).toHaveBeenCalledWith("fdaa::2", "m1", "dash");
		expect(r.ok).toBe(true);
	});

	it("passes on a refused start (the limit), and refuses on a mission that is not running", async () => {
		const { deps } = base([app({ status: "stopped" })]);
		deps.startApp.mockResolvedValueOnce({
			ok: false,
			message: "at most 3 apps run at once; running now: a, b, c",
		});
		expect(
			await openApp(
				deps,
				{ userId: "u1", isAdmin: false },
				{ missionId: "m1", name: "dash" },
			),
		).toEqual({
			ok: false,
			status: 409,
			message: "at most 3 apps run at once; running now: a, b, c",
		});
		const suspended = base(
			[app()],
			[{ missionId: "m1", userId: "u1", status: "suspended" }],
		);
		expect(
			await openApp(
				suspended.deps,
				{ userId: "u1", isAdmin: false },
				{ missionId: "m1", name: "dash" },
			),
		).toMatchObject({ ok: false, status: 409 });
	});

	it("waits for an app already starting, without starting it again", async () => {
		const { deps } = base([app({ status: "starting" })]);
		expect(
			await openApp(
				deps,
				{ userId: "u1", isAdmin: false },
				{ capability: CAP },
			),
		).toMatchObject({ ok: true });
		expect(deps.startApp).not.toHaveBeenCalled();
	});

	it("reports an app that fails while starting, with its error", async () => {
		const { deps, data } = base([app({ status: "starting" })]);
		deps.sleep = async () => {
			Object.assign(data.missionApps[0], {
				status: "failed",
				lastError: "never answered on its port",
			});
		};
		expect(
			await openApp(
				deps,
				{ userId: "u1", isAdmin: false },
				{ capability: CAP },
			),
		).toEqual({
			ok: false,
			status: 409,
			message: "app dash did not start: never answered on its port",
		});
	});

	it("gives up after 90 s of starting, asking to try again", async () => {
		const { deps } = base([app({ status: "starting" })]);
		deps.sleep = async () => {};
		expect(
			await openApp(
				deps,
				{ userId: "u1", isAdmin: false },
				{ capability: CAP },
			),
		).toMatchObject({
			ok: false,
			message: "app dash is still starting; open it again in a moment",
		});
	});

	it("lets an admin open any mission's app", async () => {
		const { deps } = base([app()]);
		expect(
			await openApp(
				deps,
				{ userId: "admin", isAdmin: true },
				{ missionId: "m1", name: "dash" },
			),
		).toMatchObject({ ok: true });
	});

	it("says interactive apps are not configured when the keys are missing", async () => {
		const { deps } = base([app()]);
		expect(
			await openApp(
				{ ...deps, ticketKey: "" },
				{ userId: "u1", isAdmin: false },
				{ capability: CAP },
			),
		).toMatchObject({ ok: false, status: 503 });
	});
});
