/**
 * The copilot's one-confirmation path to a new mission: create a draft, edit
 * and read it (the operator may edit it too), check a proposal against the
 * stored config before the operator sees a card, and tell the copilot what
 * became of each proposal.
 */
import type { MissionDoc } from "@magi/agent-config";
import { describe, expect, it } from "vitest";
import {
	actionOutcomeMessage,
	reportActionOutcome,
} from "../src/copilot-action-outcome.js";
import { preflightAction } from "../src/copilot-action-preflight.js";
import { createDraftTools } from "../src/copilot-draft-tools.js";
import { createDraftMission } from "../src/mission-drafts.js";
import { fakeDb } from "./support/fake-db.js";

const AGENT = {
	id: "lead",
	name: "Lead",
	supervisor: "user",
	systemPrompt: "You lead. {{mentalMap}}",
	initialMentalMap: "<p>Ready.</p>",
};

function missionsOf(data: Record<string, unknown[]>) {
	return data.missions as MissionDoc[];
}

function tools(db: ReturnType<typeof fakeDb>["db"]) {
	return createDraftTools({
		db,
		pushEvent: () => {},
		pending: {} as never,
		userId: "user1",
	});
}

function textOf(r: { content: Array<{ type: string; text?: string }> }) {
	return r.content.map((c) => c.text ?? "").join("");
}

describe("createDraftMission", () => {
	it("creates a blank draft owned by the user, with a spend cap and no machine", async () => {
		const { db, data } = fakeDb({ missions: [] });
		const r = await createDraftMission(db.collection("missions") as never, {
			missionId: "plants",
			name: "Plant Hotel",
			userId: "user1",
		});
		expect(r.ok).toBe(true);
		const doc = missionsOf(data)[0];
		expect(doc.status).toBe("draft");
		expect(doc.userId).toBe("user1");
		expect(doc.mission?.name).toBe("Plant Hotel");
		expect(doc.mission?.maxCostUsd).toBeGreaterThan(0);
		expect(doc.machineId).toBeUndefined();
	});

	it("refuses an invalid id, an unknown template and a duplicate", async () => {
		const { db } = fakeDb({ missions: [{ missionId: "taken" }] });
		const col = db.collection("missions") as never;
		const base = { name: "X", userId: "user1" };
		expect(
			await createDraftMission(col, { ...base, missionId: "Bad Id" }),
		).toMatchObject({ ok: false, status: 400 });
		expect(
			await createDraftMission(col, {
				...base,
				missionId: "fresh",
				templateId: "no-such-template",
			}),
		).toMatchObject({ ok: false, status: 404 });
		expect(
			await createDraftMission(col, { ...base, missionId: "taken" }),
		).toMatchObject({ ok: false, status: 409 });
	});
});

describe("draft tools", () => {
	it("CreateDraft, EditDraftConfig and ReadMissionConfig build a draft; a rename reaches the listed name", async () => {
		const { db, data } = fakeDb({ missions: [] });
		const t = tools(db);
		await t.createDraft.execute("c1", { missionId: "plants", name: "Draft" });
		const edited = await t.editDraftConfig.execute("c2", {
			missionId: "plants",
			mission: { name: "Houseplant Grand Hotel" },
			agents: [AGENT],
		});
		expect(edited.isError).toBeFalsy();
		const doc = missionsOf(data)[0];
		expect(doc.name).toBe("Houseplant Grand Hotel");
		expect(doc.mission?.name).toBe("Houseplant Grand Hotel");
		expect(doc.agents?.map((a) => a.id)).toEqual(["lead"]);

		const read = textOf(
			await t.readMissionConfig.execute("c3", { missionId: "plants" }),
		);
		expect(JSON.parse(read)).toMatchObject({
			status: "draft",
			agents: [{ id: "lead" }],
		});
	});

	it("EditDraftConfig refuses an unsafe team-file path before anything is written", async () => {
		const { db, data } = fakeDb({ missions: [] });
		const t = tools(db);
		await t.createDraft.execute("c1", { missionId: "plants", name: "Draft" });
		const r = await t.editDraftConfig.execute("c2", {
			missionId: "plants",
			teamFiles: [{ path: "../escape.md", content: "x" }],
		});
		expect(r.isError).toBe(true);
		expect(missionsOf(data)[0].teamFiles).toEqual([]);
	});
});

describe("preflightAction", () => {
	const draft = (agents: unknown[]): MissionDoc =>
		({
			missionId: "plants",
			userId: "user1",
			status: "draft",
			mission: { id: "plants", name: "Plants", maxCostUsd: 10 },
			agents,
			teamFiles: [],
		}) as MissionDoc;

	it("reports a draft that would fail at launch, and passes a valid one", async () => {
		const empty = fakeDb({ missions: [draft([])] });
		expect(
			await preflightAction(
				empty.db,
				"launch_draft",
				{ missionId: "plants" },
				"user1",
			),
		).toMatch(/Invalid team config/);

		const valid = fakeDb({ missions: [draft([AGENT])] });
		expect(
			await preflightAction(
				valid.db,
				"launch_draft",
				{ missionId: "plants" },
				"user1",
			),
		).toBeNull();
	});

	it("only sees the caller's missions, and leaves other action types to their schema", async () => {
		const { db } = fakeDb({ missions: [draft([AGENT])] });
		expect(
			await preflightAction(
				db,
				"launch_draft",
				{ missionId: "plants" },
				"other",
			),
		).toMatch(/not found/);
		expect(
			await preflightAction(db, "suspend_mission", { missionId: "x" }, "user1"),
		).toBeNull();
	});

	it("reports a session-config patch that introduces an unknown model", async () => {
		const suspended = { ...draft([AGENT]), status: "suspended" } as MissionDoc;
		const { db } = fakeDb({ missions: [suspended] });
		expect(
			await preflightAction(
				db,
				"save_session_config",
				{ missionId: "plants", mission: { model: "openrouter/auto" } },
				"user1",
			),
		).toMatch(/unknown model id/);
	});
});

describe("action outcomes reach the copilot", () => {
	const action = {
		id: "a1",
		type: "launch_draft",
		label: 'Launch draft "plants"',
		userId: "user1",
	};

	it("says what happened and what to do next", () => {
		const failed = actionOutcomeMessage(action, {
			kind: "failed",
			error: "Invalid team config: agents: too small",
		});
		expect(failed.subject).toContain("FAILED");
		expect(failed.body).toContain("Invalid team config");
		expect(failed.body).toMatch(/propose a corrected action/);
		expect(
			actionOutcomeMessage(action, { kind: "dismissed" }).subject,
		).toContain("dismissed");
	});

	it("posts to the user's copilot mailbox", async () => {
		const { db, data } = fakeDb({ mailbox: [] });
		await reportActionOutcome(db, action, {
			kind: "executed",
			result: "launched",
		});
		expect(data.mailbox).toHaveLength(1);
		expect(data.mailbox[0]).toMatchObject({
			missionId: "copilot-user1",
			from: "system",
			to: ["copilot"],
		});
	});
});
