/**
 * Copilot waker against real MongoDB (ADR-0032 Decision 1) — no LLM, no
 * daemon: `ensureCopilotRunning` is a spy. Proves the Change Stream filter
 * and the stranded-mail scan behave against the real server, which the
 * unit tests' fake collection cannot.
 */

import { randomUUID } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { connectMongo } from "../../agent-runtime-worker/src/mongo.js";
import {
	startCopilotWaker,
	wakeStrandedCopilots,
} from "../src/copilot-waker.js";

describe("copilot waker (real MongoDB)", () => {
	// biome-ignore lint/style/noNonNullAssertion: required env var; vitest.setup.ts validates presence
	const MONGODB_URI = process.env.MONGODB_URI!;

	let client: MongoClient;
	let db: Db;
	const userId = `waker-user-${randomUUID()}`;
	const otherMissionId = `waker-mission-${randomUUID()}`;
	const copilotMissionId = `copilot-${userId}`;

	function mail(overrides: Record<string, unknown> = {}) {
		return {
			id: randomUUID(),
			missionId: copilotMissionId,
			from: "system",
			to: ["copilot"],
			subject: "Anomaly (hard): agent-crash — mission x",
			body: "test relay",
			timestamp: new Date(),
			readBy: [] as string[],
			...overrides,
		};
	}

	// One connection for the whole file, with a generous timeout: this Atlas
	// cluster's connect time is 10s+ here (slow SRV/DNS lookup), and a
	// per-test reconnect made the last test flake on a lookup timeout.
	beforeAll(async () => {
		({ client, db } = await connectMongo(MONGODB_URI, "magi-test"));
	}, 60_000);

	afterAll(async () => {
		await client.close();
	});

	afterEach(async () => {
		await db
			.collection("mailbox")
			.deleteMany({ missionId: { $in: [copilotMissionId, otherMissionId] } });
	});

	it("scan: finds a relay stranded in a copilot mailbox, and stops once the copilot has read it", async () => {
		const doc = mail();
		await db.collection("mailbox").insertOne(doc);
		const ensure = vi.fn().mockResolvedValue(undefined);

		await wakeStrandedCopilots(db, ensure);
		expect(ensure).toHaveBeenCalledWith(userId);

		await db
			.collection("mailbox")
			.updateOne({ id: doc.id }, { $addToSet: { readBy: "copilot" } });
		ensure.mockClear();
		await wakeStrandedCopilots(db, ensure);
		expect(ensure).not.toHaveBeenCalledWith(userId);
	}, 30_000);

	it("scan: ignores mail to other recipients and non-copilot mailboxes", async () => {
		await db.collection("mailbox").insertMany([
			mail({ to: ["user"] }), // the copilot's own reply to the operator
			mail({ missionId: otherMissionId }), // a mission's mail addressed to "copilot"
		]);
		const ensure = vi.fn().mockResolvedValue(undefined);

		await wakeStrandedCopilots(db, ensure);

		expect(ensure).not.toHaveBeenCalledWith(userId);
		expect(ensure).not.toHaveBeenCalledWith(otherMissionId);
	}, 30_000);

	it("change stream: wakes the user's copilot when mail arrives after the waker started", async () => {
		const ensure = vi.fn().mockResolvedValue(undefined);
		// A huge scan interval so only the stream can produce the wake-up below.
		const stop = startCopilotWaker(db, ensure, {
			scanIntervalMs: 60 * 60_000,
		});
		try {
			// Let the stream's server-side cursor open and the startup scan finish.
			await new Promise((r) => setTimeout(r, 3_000));
			expect(ensure).not.toHaveBeenCalledWith(userId);

			await db.collection("mailbox").insertOne(mail());

			await vi.waitFor(() => expect(ensure).toHaveBeenCalledWith(userId), {
				timeout: 15_000,
				interval: 250,
			});
		} finally {
			stop();
		}
	}, 45_000);

	it("change stream: does not wake anyone for mail to a mission agent or to the operator", async () => {
		const ensure = vi.fn().mockResolvedValue(undefined);
		const stop = startCopilotWaker(db, ensure, {
			scanIntervalMs: 60 * 60_000,
		});
		try {
			await new Promise((r) => setTimeout(r, 3_000));
			await db
				.collection("mailbox")
				.insertMany([
					mail({ to: ["user"] }),
					mail({ missionId: otherMissionId }),
				]);
			await new Promise((r) => setTimeout(r, 3_000));
			expect(ensure).not.toHaveBeenCalledWith(userId);
			expect(ensure).not.toHaveBeenCalledWith(otherMissionId);
		} finally {
			stop();
		}
	}, 45_000);
});
