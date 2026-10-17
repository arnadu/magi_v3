import { describe, expect, it } from "vitest";
import {
	ACTION_TYPES,
	ActionValidationError,
	actionLabel,
	describeActions,
	parseActionPayload,
} from "../src/copilot-actions.js";

describe("parseActionPayload (typed action registry)", () => {
	it("rejects an unknown action type, listing the valid ones", () => {
		expect(() => parseActionPayload("save_template", {})).toThrow(
			/Unknown action type "save_template"\. Valid: launch_mission/,
		);
	});

	it("rejects unknown keys — the SCFG1 teamConfigYaml case", () => {
		expect(() =>
			parseActionPayload("save_session_config", {
				missionId: "m1",
				teamConfigYaml: "mission: …",
			}),
		).toThrow(ActionValidationError);
		try {
			parseActionPayload("save_session_config", {
				missionId: "m1",
				teamConfigYaml: "x",
			});
		} catch (e) {
			expect((e as Error).message).toMatch(/teamConfigYaml/);
			expect((e as Error).message).toMatch(/Expected \{ missionId/);
		}
	});

	it("rejects the SCHED3 shape (agentId/cronExpression/message) and a bare schedule with neither cron nor deliverAt", () => {
		expect(() =>
			parseActionPayload("create_schedule", {
				missionId: "m1",
				agentId: "lead",
				cronExpression: "30 8 * * 1-5",
				message: "brief",
			}),
		).toThrow(/to|subject|body/);
		expect(() =>
			parseActionPayload("create_schedule", {
				missionId: "m1",
				to: ["lead"],
				subject: "s",
				body: "b",
			}),
		).toThrow(/cron or deliverAt is required/);
		expect(() =>
			parseActionPayload("create_schedule", {
				missionId: "m1",
				to: ["lead"],
				subject: "s",
				body: "b",
				cron: "every monday",
			}),
		).toThrow(/not a valid cron expression/);
	});

	it("accepts a correct schedule and computes the card label", () => {
		const r = parseActionPayload("create_schedule", {
			missionId: "gold-digest-001",
			to: ["lead-analyst"],
			subject: "Daily brief",
			body: "Please produce today's brief.",
			cron: "30 8 * * 1-5",
			label: "Daily brief",
		});
		expect(r.type).toBe("create_schedule");
		expect(r.label).toBe(
			'Schedule "Daily brief" → lead-analyst in mission "gold-digest-001" (cron 30 8 * * 1-5)',
		);
	});

	it("parses a JSON-string payload and refuses an unparseable one", () => {
		expect(
			parseActionPayload("suspend_mission", '{"missionId":"m1"}').payload,
		).toEqual({ missionId: "m1" });
		expect(() => parseActionPayload("suspend_mission", "{oops")).toThrow(
			/must be a JSON object/,
		);
	});

	it("validates cancel_schedule ids and budgets", () => {
		expect(() =>
			parseActionPayload("cancel_schedule", { id: "not-an-object-id" }),
		).toThrow(/24-hex/);
		expect(
			parseActionPayload("cancel_schedule", {
				id: "0123456789abcdef01234567",
			}).label,
		).toBe("Cancel scheduled message 0123456789abcdef01234567");
		expect(() =>
			parseActionPayload("set_mission_budget", { missionId: "m", capUsd: -1 }),
		).toThrow(/capUsd/);
		expect(() =>
			parseActionPayload("set_mission_budget", {
				missionId: "m",
				capUsd: "25",
			}),
		).toThrow(/capUsd/);
	});

	it("routes file_github_issue through its own validator and label", () => {
		const r = parseActionPayload("file_github_issue", {
			op: "create",
			title: "T",
			body: "B",
		});
		expect(r.label).toMatch(/^Create GitHub issue in .*“T”$/);
		expect(() =>
			parseActionPayload("file_github_issue", { op: "create", title: "T" }),
		).toThrow(/body is required/);
	});

	it("has a label and a doc line for every registered type", () => {
		for (const t of ACTION_TYPES) {
			expect(describeActions()).toContain(`- ${t}: `);
		}
		expect(actionLabel("pause_agent", { missionId: "m", agentId: "a" })).toBe(
			'Pause agent "a" in mission "m"',
		);
		expect(
			actionLabel("save_session_config", {
				missionId: "m",
				agents: [],
				mentalMaps: {},
			}),
		).toBe('Save config of mission "m" (agents, mentalMaps)');
	});
});
