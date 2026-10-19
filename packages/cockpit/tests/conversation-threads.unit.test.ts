import { describe, expect, it, vi } from "vitest";
import {
	buildThreads,
	messagesWithin,
	threadsWithin,
	timeAgo,
} from "../src/conversations/threads";
import type { ConvMessage } from "../src/data";

let n = 0;
const msg = (
	from: string,
	to: string[],
	at: string,
	read = false,
): ConvMessage =>
	({
		id: `m${n++}`,
		from,
		to,
		subject: "",
		body: `${from}->${to.join(",")}`,
		timestamp: at,
		read,
	}) as ConvMessage;

describe("buildThreads", () => {
	it("groups by participant set, drops user-only noise, unread first then recent", () => {
		const threads = buildThreads([
			msg("user", ["analyst"], "2026-10-19T10:00:00Z"),
			msg("analyst", ["user"], "2026-10-19T10:05:00Z", true),
			msg("lead", ["user"], "2026-10-19T09:00:00Z"),
			msg("user", ["user"], "2026-10-19T11:00:00Z"),
		]);
		expect(threads.map((t) => t.participants)).toEqual([["lead"], ["analyst"]]);
		expect(threads[0].unread).toBe(1);
		expect(threads[1].messages).toHaveLength(2);
		expect(threads[1].last.from).toBe("analyst");
	});
});

describe("threadsWithin / messagesWithin", () => {
	it("a multi-recipient selection includes each recipient's 1:1 replies, oldest first", () => {
		const threads = buildThreads([
			msg("user", ["analyst", "lead"], "2026-10-19T10:00:00Z"),
			msg("lead", ["user"], "2026-10-19T10:02:00Z"),
			msg("analyst", ["user"], "2026-10-19T10:01:00Z"),
			msg("quant", ["user"], "2026-10-19T10:03:00Z"),
		]);
		expect(threadsWithin(threads, ["analyst", "lead"])).toHaveLength(3);
		expect(
			messagesWithin(threads, ["analyst", "lead"]).map((m) => m.from),
		).toEqual(["user", "analyst", "lead"]);
		expect(messagesWithin(threads, [])).toEqual([]);
	});
});

describe("timeAgo", () => {
	it("seconds, minutes, hours, then a date", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
		expect(timeAgo("2026-10-19T11:59:30Z")).toBe("30s");
		expect(timeAgo("2026-10-19T11:30:00Z")).toBe("30m");
		expect(timeAgo("2026-10-19T09:00:00Z")).toBe("3h");
		expect(timeAgo("2026-10-10T09:00:00Z")).toBe(
			new Date("2026-10-10T09:00:00Z").toLocaleDateString(),
		);
		vi.useRealTimers();
	});
});
