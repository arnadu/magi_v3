import { describe, expect, it } from "vitest";
import {
	actionEntry,
	type Entry,
	fmtTokens,
	formatPayload,
	formatToolArgs,
	loopMessageEntries,
	withActionResult,
} from "../src/copilot/copilot-entries";

describe("loopMessageEntries", () => {
	it("one activity line per tool call, with the most telling argument", () => {
		const out = loopMessageEntries({
			role: "assistant",
			stopReason: "toolUse",
			content: [
				{ type: "text", text: "thinking" },
				{
					type: "toolCall",
					name: "ReadMissionLog",
					arguments: { missionId: "m1" },
				},
				{ type: "toolCall", name: "ListMissions", arguments: {} },
			],
		});
		expect(out.done).toBe(false);
		expect(out.entries.map((e) => (e as { text: string }).text)).toEqual([
			"▶ ReadMissionLog: m1",
			"▶ ListMissions",
		]);
	});

	it("an LLM error ends the turn", () => {
		const out = loopMessageEntries({
			role: "assistant",
			stopReason: "error",
			errorMessage: "overloaded",
		});
		expect(out).toEqual({
			entries: [
				{ kind: "activity", text: "⚠ LLM error: overloaded", isError: true },
			],
			done: true,
		});
	});

	it("tool results are previewed; PostMessage results are not repeated", () => {
		const long = "x".repeat(200);
		const out = loopMessageEntries({
			role: "toolResult",
			toolName: "ReadMissionLog",
			isError: true,
			content: [{ type: "text", text: long }],
		});
		expect(out.entries[0]).toEqual({
			kind: "activity",
			text: `← ReadMissionLog: ${"x".repeat(150)}…`,
			isError: true,
		});
		expect(
			loopMessageEntries({
				role: "toolResult",
				toolName: "PostMessage",
				content: [],
			}).entries,
		).toEqual([]);
	});
});

describe("withActionResult", () => {
	it("resolves only the matching card", () => {
		const entries: Entry[] = [
			{ id: 1, kind: "action", actionId: "a", type: "t", label: "A" },
			{ id: 2, kind: "action", actionId: "b", type: "t", label: "B" },
			{ id: 3, kind: "user", text: "hi" },
		];
		const out = withActionResult(entries, {
			id: "b",
			ok: false,
			error: "nope",
		});
		expect(out[0]).toBe(entries[0]);
		expect(out[1]).toMatchObject({ resolved: { ok: false, text: "nope" } });
		expect(out[2]).toBe(entries[2]);
	});
});

describe("formatting", () => {
	it("truncates long payloads and long tool arguments", () => {
		expect(formatPayload({ a: "y".repeat(5000) })).toContain("more characters");
		expect(formatToolArgs({ command: "z".repeat(100) })).toHaveLength(71);
		expect(formatToolArgs(null)).toBe("");
	});
});

describe("cards and token counts", () => {
	it("actionEntry turns a proposed action into an unresolved card", () => {
		expect(
			actionEntry({
				id: "a1",
				type: "suspend_mission",
				label: "Suspend m1",
				payload: { m: 1 },
			}),
		).toEqual({
			kind: "action",
			actionId: "a1",
			type: "suspend_mission",
			label: "Suspend m1",
			payload: { m: 1 },
		});
	});

	it("fmtTokens abbreviates thousands", () => {
		expect(fmtTokens(950)).toBe("950 tok");
		expect(fmtTokens(12_400)).toBe("12k tok");
	});
});

describe("sparse loop messages", () => {
	it("tolerate missing content, error text and flags", () => {
		expect(
			loopMessageEntries({ role: "assistant", stopReason: "error" }).entries[0],
		).toMatchObject({ text: "⚠ LLM error: (no details)" });
		expect(
			loopMessageEntries({ role: "assistant", stopReason: "stop" }),
		).toEqual({
			entries: [],
			done: false,
		});
		expect(
			loopMessageEntries({ role: "toolResult", toolName: "Bash" }).entries[0],
		).toEqual({ kind: "activity", text: "← Bash: ", isError: false });
		expect(loopMessageEntries({ role: "user", content: "hi" }).entries).toEqual(
			[],
		);
	});

	it("resolve a successful card with its result text", () => {
		const out = withActionResult(
			[{ id: 1, kind: "action", actionId: "a", type: "t", label: "A" }],
			{ id: "a", ok: true },
		);
		expect(out[0]).toMatchObject({ resolved: { ok: true, text: "" } });
	});
});
