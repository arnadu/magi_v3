/**
 * SCH-4: nothing runs without a hard cap. ensureMissionSpendCap runs before
 * every machine start, backfillMissionCaps at control-plane start — both
 * against real MongoDB, where a `null` filter must also match a missing field.
 */

import { randomUUID } from "node:crypto";
import { DEFAULT_MISSION_MAX_COST_USD } from "@magi/agent-config";
import type { Db, MongoClient } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectMongo } from "../../agent-runtime-worker/src/mongo.js";
import {
	backfillMissionCaps,
	ensureMissionSpendCap,
} from "../src/spend-policy.js";

describe("spend cap guarantee", () => {
	// biome-ignore lint/style/noNonNullAssertion: required env var; vitest.setup.ts validates presence
	const MONGODB_URI = process.env.MONGODB_URI!;
	let client: MongoClient;
	let db: Db;
	const tag = randomUUID();
	const id = (name: string) => `spend-cap-${name}-${tag}`;

	beforeEach(async () => {
		({ client, db } = await connectMongo(MONGODB_URI, "magi-test"));
		await db.collection("missions").insertMany([
			{
				missionId: id("missing"),
				status: "draft",
				mission: { id: "x", name: "x" },
			},
			{
				missionId: id("null"),
				status: "suspended",
				mission: { id: "x", name: "x", maxCostUsd: null },
			},
			{
				missionId: id("capped"),
				status: "running",
				mission: { id: "x", name: "x", maxCostUsd: 7 },
			},
			{
				missionId: id("destroyed"),
				status: "destroyed",
				mission: { id: "x", name: "x" },
			},
		]);
	});

	afterEach(async () => {
		await db
			.collection("missions")
			.deleteMany({ missionId: { $regex: `^spend-cap-.*-${tag}$` } });
		await client.close();
	});

	const capOf = async (name: string) =>
		(await db.collection("missions").findOne({ missionId: id(name) }))?.mission
			?.maxCostUsd;

	it("ensureMissionSpendCap gives a missing or null cap the default and leaves a set cap alone", async () => {
		for (const name of ["missing", "null", "capped"]) {
			await ensureMissionSpendCap(db, id(name));
		}
		expect(await capOf("missing")).toBe(DEFAULT_MISSION_MAX_COST_USD);
		expect(await capOf("null")).toBe(DEFAULT_MISSION_MAX_COST_USD);
		expect(await capOf("capped")).toBe(7);
	});

	it("backfillMissionCaps caps every live mission that has none, and skips destroyed ones", async () => {
		await backfillMissionCaps(db);
		expect(await capOf("missing")).toBe(DEFAULT_MISSION_MAX_COST_USD);
		expect(await capOf("null")).toBe(DEFAULT_MISSION_MAX_COST_USD);
		expect(await capOf("capped")).toBe(7);
		expect(await capOf("destroyed")).toBeUndefined();
	});
});
