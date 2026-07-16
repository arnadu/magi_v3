/**
 * formatMessages() / safeTimestamp() — regression test for a real production
 * crash: control-plane's scheduler.ts inserted a mailbox document directly
 * into MongoDB (bypassing MailboxRepository.post()) with no `timestamp`
 * field. formatMessages() called `m.timestamp.toISOString()` unconditionally,
 * crashing the receiving agent's entire dispatch with
 * "Cannot read properties of undefined (reading 'toISOString')" before any
 * turn tracking began — the task was silently dropped with no recovery path.
 */

import { describe, expect, it } from "vitest";
import type { MailboxMessage } from "../src/mailbox.js";
import { safeTimestamp } from "../src/mailbox.js";
import { formatMessages } from "../src/prompt.js";

function baseMessage(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
	return {
		id: "m1",
		missionId: "mission-1",
		from: "user",
		to: ["analyst"],
		subject: "Test subject",
		body: "Test body",
		timestamp: new Date("2026-07-16T11:33:00.000Z"),
		readBy: [],
		...overrides,
	};
}

describe("safeTimestamp", () => {
	it("returns the ISO string for a valid Date", () => {
		expect(safeTimestamp(baseMessage())).toBe("2026-07-16T11:33:00.000Z");
	});

	it('returns "unknown" instead of throwing when timestamp is missing (scheduler.ts bug)', () => {
		const msg = baseMessage();
		// biome-ignore lint/suspicious/noExplicitAny: simulating a malformed document read straight from Mongo
		(msg as any).timestamp = undefined;
		expect(() => safeTimestamp(msg)).not.toThrow();
		expect(safeTimestamp(msg)).toBe("unknown");
	});

	it('returns "unknown" for an Invalid Date rather than "Invalid Date"', () => {
		expect(
			safeTimestamp(baseMessage({ timestamp: new Date("not-a-date") })),
		).toBe("unknown");
	});
});

describe("formatMessages", () => {
	it("returns the no-messages placeholder for an empty list", () => {
		expect(formatMessages([])).toContain("You have no new messages");
	});

	it("formats a normal message with its real timestamp", () => {
		const text = formatMessages([baseMessage()]);
		expect(text).toContain("Time: 2026-07-16T11:33:00.000Z");
		expect(text).toContain("Test subject");
		expect(text).toContain("Test body");
	});

	it("does not throw and degrades gracefully when a message has no timestamp", () => {
		const msg = baseMessage();
		// biome-ignore lint/suspicious/noExplicitAny: simulating a malformed document read straight from Mongo
		(msg as any).timestamp = undefined;
		expect(() => formatMessages([msg])).not.toThrow();
		const text = formatMessages([msg]);
		expect(text).toContain("Time: unknown");
		expect(text).toContain("Test body");
	});
});
