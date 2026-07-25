/**
 * copilot-router.ts's executeAction — save_session_config unit tests.
 *
 * Pins the structured partial-patch behavior (ADR-0021, Stage 3c):
 * `mission` shallow-merges, `agents` upserts by id into the current roster,
 * `missionCopilotLimits` replaces wholesale, and any of the three omitted
 * from the payload leaves that field untouched. No MongoDB, no HTTP — a
 * fake in-memory Db, matching this repo's existing mock-based test style
 * (see scheduler.unit.test.ts).
 */

import type { AgentConfig, Limits, TeamConfig } from "@magi/agent-config";
import { describe, expect, it } from "vitest";
import { executeAction } from "../src/copilot-router.js";
import type { PendingAction } from "../src/copilot-tools.js";

interface MissionDoc {
	missionId: string;
	userId: string;
	status: string;
	mission?: TeamConfig["mission"];
	agents?: AgentConfig[];
	missionCopilotLimits?: Limits;
	teamFiles?: Array<{ path: string; content: string }>;
	updatedAt?: Date;
}

interface ConvDoc {
	_id: string;
	agentId: string;
	missionId: string;
	mentalMapHtml?: string;
	turnNumber: number;
	seqInTurn: number;
}

function fakeDb(opts: { missions: MissionDoc[]; conv?: ConvDoc[] }) {
	const missions = opts.missions;
	const conv = opts.conv ?? [];

	return {
		collection(name: string) {
			if (name === "missions") {
				return {
					async findOne(filter: Partial<MissionDoc>) {
						return (
							missions.find(
								(m) =>
									m.missionId === filter.missionId &&
									(filter.userId === undefined || m.userId === filter.userId),
							) ?? null
						);
					},
					async updateOne(
						filter: { missionId: string },
						update: { $set: Partial<MissionDoc> },
					) {
						const doc = missions.find((m) => m.missionId === filter.missionId);
						if (doc) Object.assign(doc, update.$set);
						return { acknowledged: true };
					},
					async insertOne() {
						return { acknowledged: true };
					},
				};
			}
			if (name === "missionConfigRevisions") {
				return {
					async insertOne() {
						return { acknowledged: true };
					},
					async createIndex() {
						return "ok";
					},
				};
			}
			if (name === "conversationMessages") {
				return {
					async findOne(filter: {
						agentId: string;
						missionId: string;
						mentalMapHtml: { $exists: boolean };
					}) {
						const matches = conv
							.filter(
								(c) =>
									c.agentId === filter.agentId &&
									c.missionId === filter.missionId &&
									c.mentalMapHtml !== undefined,
							)
							.sort(
								(a, b) =>
									b.turnNumber - a.turnNumber || b.seqInTurn - a.seqInTurn,
							);
						return matches[0] ?? null;
					},
					async updateOne(
						filter: { _id: string },
						update: { $set: { mentalMapHtml: string } },
					) {
						const doc = conv.find((c) => c._id === filter._id);
						if (doc) doc.mentalMapHtml = update.$set.mentalMapHtml;
						return { acknowledged: true };
					},
				};
			}
			throw new Error(`fakeDb: unexpected collection "${name}"`);
		},
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake, not a full Db
	} as any;
}

const BASE_MISSION: TeamConfig["mission"] = { id: "m1", name: "M1" };
const BASE_AGENTS: AgentConfig[] = [
	{
		id: "analyst",
		name: "analyst",
		role: "analyst",
		supervisor: "user",
		systemPrompt: "You are an analyst.",
		initialMentalMap: '<section id="status"><p>Ready.</p></section>',
	},
];

function makeAction(payload: unknown): PendingAction {
	return {
		id: "action-1",
		userId: "user1",
		type: "save_session_config",
		label: "Save session config",
		payload,
		createdAt: new Date(),
	};
}

function suspendedMission(overrides: Partial<MissionDoc> = {}): MissionDoc {
	return {
		missionId: "m1",
		userId: "user1",
		status: "suspended",
		mission: { ...BASE_MISSION },
		agents: BASE_AGENTS.map((a) => ({ ...a })),
		...overrides,
	};
}

describe("executeAction: save_session_config", () => {
	it("requires missionId", async () => {
		const db = fakeDb({ missions: [] });
		const result = await executeAction(db, makeAction({}), "user1");
		expect(result).toBe("save_session_config: missionId is required");
	});

	it("returns an error when the mission is not found (or not owned by the caller)", async () => {
		const db = fakeDb({ missions: [] });
		const result = await executeAction(
			db,
			makeAction({ missionId: "m1" }),
			"user1",
		);
		expect(result).toBe("Mission m1 not found");
	});

	it("refuses to edit a running (non-suspended) mission", async () => {
		const db = fakeDb({
			missions: [suspendedMission({ status: "running" })],
		});
		const result = await executeAction(
			db,
			makeAction({ missionId: "m1" }),
			"user1",
		);
		expect(result).toBe(
			"Mission m1 must be suspended before editing config (current: running)",
		);
	});

	it("rejects an invalid resulting config without writing", async () => {
		const missions = [suspendedMission()];
		const db = fakeDb({ missions });
		const result = await executeAction(
			db,
			makeAction({ missionId: "m1", mission: { name: "" } }),
			"user1",
		);
		expect(result).toContain("Invalid team config:");
		expect(missions[0].mission?.name).toBe("M1");
	});

	it("shallow-merges a mission patch, preserving the mission id and unspecified fields", async () => {
		const missions = [
			suspendedMission({ mission: { ...BASE_MISSION, maxCostUsd: 10 } }),
		];
		const db = fakeDb({ missions });
		const result = await executeAction(
			db,
			makeAction({ missionId: "m1", mission: { name: "Renamed" } }),
			"user1",
		);
		expect(result).toBe("Session config saved for mission m1");
		expect(missions[0].mission).toEqual({
			id: "m1",
			name: "Renamed",
			maxCostUsd: 10,
		});
	});

	it("upserts an agent by id, replacing a match and appending a new id", async () => {
		const missions = [suspendedMission()];
		const db = fakeDb({ missions });
		await executeAction(
			db,
			makeAction({
				missionId: "m1",
				agents: [
					{
						id: "analyst",
						supervisor: "user",
						systemPrompt: "Updated prompt.",
						initialMentalMap: "<p>x</p>",
					},
					{
						id: "trader",
						supervisor: "analyst",
						systemPrompt: "You trade.",
						initialMentalMap: "<p>y</p>",
					},
				],
			}),
			"user1",
		);
		const ids = missions[0].agents?.map((a) => a.id).sort();
		expect(ids).toEqual(["analyst", "trader"]);
		const analyst = missions[0].agents?.find((a) => a.id === "analyst");
		expect(analyst?.systemPrompt).toBe("Updated prompt.");
	});

	it("leaves agents untouched when omitted", async () => {
		const missions = [suspendedMission()];
		const db = fakeDb({ missions });
		await executeAction(
			db,
			makeAction({ missionId: "m1", mission: { name: "Renamed" } }),
			"user1",
		);
		expect(missions[0].agents).toEqual(BASE_AGENTS);
	});

	it("rejects a payload naming the reserved mission-copilot agent id", async () => {
		const missions = [suspendedMission()];
		const db = fakeDb({ missions });
		const result = await executeAction(
			db,
			makeAction({
				missionId: "m1",
				agents: [
					{
						id: "mission-copilot",
						supervisor: "user",
						systemPrompt: "x",
						initialMentalMap: "x",
					},
				],
			}),
			"user1",
		);
		expect(result).toContain("Invalid team config:");
	});

	it("writes teamFiles only when explicitly provided", async () => {
		const missions = [
			suspendedMission({ teamFiles: [{ path: "old.md", content: "keep" }] }),
		];
		const db = fakeDb({ missions });
		await executeAction(
			db,
			makeAction({ missionId: "m1", mission: { name: "Renamed" } }),
			"user1",
		);
		expect(missions[0].teamFiles).toEqual([
			{ path: "old.md", content: "keep" },
		]);

		await executeAction(
			db,
			makeAction({
				missionId: "m1",
				teamFiles: [{ path: "new.md", content: "x" }],
			}),
			"user1",
		);
		expect(missions[0].teamFiles).toEqual([{ path: "new.md", content: "x" }]);
	});

	it("updates each agent's latest mental map when mentalMaps is provided", async () => {
		const missions = [suspendedMission()];
		const conv: ConvDoc[] = [
			{
				_id: "c1",
				agentId: "analyst",
				missionId: "m1",
				mentalMapHtml: "<p>old</p>",
				turnNumber: 1,
				seqInTurn: 0,
			},
			{
				_id: "c2",
				agentId: "analyst",
				missionId: "m1",
				mentalMapHtml: "<p>newer</p>",
				turnNumber: 2,
				seqInTurn: 0,
			},
		];
		const db = fakeDb({ missions, conv });
		await executeAction(
			db,
			makeAction({
				missionId: "m1",
				mentalMaps: { analyst: "<p>updated</p>" },
			}),
			"user1",
		);
		expect(conv.find((c) => c._id === "c2")?.mentalMapHtml).toBe(
			"<p>updated</p>",
		);
		expect(conv.find((c) => c._id === "c1")?.mentalMapHtml).toBe("<p>old</p>");
	});
});
