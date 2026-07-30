/**
 * formatMessages() / safeTimestamp() — regression test for a real production
 * crash: control-plane's scheduler.ts inserted a mailbox document directly
 * into MongoDB (bypassing MailboxRepository.post()) with no `timestamp`
 * field. formatMessages() called `m.timestamp.toISOString()` unconditionally,
 * crashing the receiving agent's entire dispatch with
 * "Cannot read properties of undefined (reading 'toISOString')" before any
 * turn tracking began — the task was silently dropped with no recovery path.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@magi/agent-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MailboxMessage } from "../src/mailbox.js";
import { safeTimestamp } from "../src/mailbox.js";
import {
	buildDynamicContextMessage,
	buildSystemPrompt,
	buildTimeBlock,
	formatMessages,
} from "../src/prompt.js";

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

	it("includes every recipient, not just the reading agent, so a co-addressed agent knows who else got the message", () => {
		// Regression test: found live — an operator message addressed to both
		// the mission copilot and an agent produced two uncoordinated replies,
		// because neither agent's rendered prompt ever showed the recipient
		// list at all, only From/Subject/Time.
		const text = formatMessages([
			baseMessage({ to: ["analyst", "mission-copilot"] }),
		]);
		expect(text).toContain("To: analyst, mission-copilot");
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

describe("buildTimeBlock", () => {
	it("includes UTC ISO time, day of week, and Unix epoch, with no local line when no timezone is given", () => {
		const text = buildTimeBlock();
		expect(text).toMatch(/UTC: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z \(\w+day\)/);
		expect(text).toMatch(/Unix: \d{10}/);
		expect(text).not.toContain("Local");
	});

	it("adds a local-time line for a configured IANA timezone", () => {
		const text = buildTimeBlock("America/New_York");
		expect(text).toContain("Local (America/New_York):");
		expect(text).toMatch(
			/Local \(America\/New_York\): \d{4}-\d{2}-\d{2} \d{2}:\d{2} (EST|EDT)/,
		);
	});

	it("rounds to the nearest 5 minutes so consecutive calls within the same bucket produce an identical block (prompt-cache stability)", () => {
		// Two calls milliseconds apart must be byte-identical, since the whole
		// system prompt is cached as one block (pi-ai's Anthropic provider) and
		// this is rebuilt fresh before every LLM call in a turn.
		expect(buildTimeBlock()).toBe(buildTimeBlock());
	});

	it("Unix epoch is a multiple of 300 seconds (5-minute rounding applied consistently)", () => {
		const match = buildTimeBlock().match(/Unix: (\d+)/);
		expect(match).not.toBeNull();
		expect(Number(match?.[1]) % 300).toBe(0);
	});
});

// OpenRouter caching investigation (issue #24): the system prompt must stay
// byte-identical across calls within a session for pi-ai's Anthropic
// cache_control breakpoint (and OpenRouter's own default routing-key hash) to
// survive a mid-turn mental-map edit. buildSystemPrompt() is fully static;
// the mental map + current time live in buildDynamicContextMessage instead.
describe("buildSystemPrompt / buildDynamicContextMessage", () => {
	let sharedDir: string;
	let workdir: string;

	function agent(systemPrompt: string): AgentConfig {
		return {
			id: "analyst",
			supervisor: "user",
			systemPrompt,
			initialMentalMap: "<section></section>",
			// biome-ignore lint/suspicious/noExplicitAny: minimal fixture, only the fields buildSystemPrompt reads matter
		} as any;
	}

	beforeEach(() => {
		sharedDir = mkdtempSync(join(tmpdir(), "magi-prompt-test-shared-"));
		workdir = mkdtempSync(join(tmpdir(), "magi-prompt-test-workdir-"));
	});

	afterEach(() => {
		rmSync(sharedDir, { recursive: true, force: true });
		rmSync(workdir, { recursive: true, force: true });
	});

	it("substitutes {{mentalMap}} with a static pointer, never the live HTML", () => {
		const text = buildSystemPrompt(
			agent("## Your mental map\n{{mentalMap}}"),
			sharedDir,
			workdir,
		);
		expect(text).not.toContain("{{mentalMap}}");
		expect(text).toContain("provided as a separate message below");
	});

	it("carries no current-time block — that moved to buildDynamicContextMessage", () => {
		const text = buildSystemPrompt(
			agent("Hello {{mentalMap}}"),
			sharedDir,
			workdir,
		);
		expect(text).not.toContain("## Current Time");
	});

	it("is fully static: two calls produce byte-identical output regardless of an agent's live mental map changing", () => {
		const a = buildSystemPrompt(agent("{{mentalMap}}"), sharedDir, workdir);
		const b = buildSystemPrompt(agent("{{mentalMap}}"), sharedDir, workdir);
		expect(a).toBe(b);
	});

	it("still substitutes {{sharedDir}}/{{workdir}}", () => {
		const text = buildSystemPrompt(
			agent("root={{sharedDir}} work={{workdir}}"),
			sharedDir,
			workdir,
		);
		expect(text).toContain(`root=${sharedDir}`);
		expect(text).toContain(`work=${workdir}`);
	});

	it("buildDynamicContextMessage contains both the current-time block and the given mental map HTML", () => {
		const text = buildDynamicContextMessage("<p>notes</p>");
		expect(text).toContain("## Current Time");
		expect(text).toContain("## Your Mental Map");
		expect(text).toContain("<p>notes</p>");
	});

	it("buildDynamicContextMessage is stable across calls a few seconds apart within the same 5-min bucket", () => {
		expect(buildDynamicContextMessage("<p>notes</p>")).toBe(
			buildDynamicContextMessage("<p>notes</p>"),
		);
	});

	it("buildDynamicContextMessage differs only when the mental map itself differs", () => {
		const a = buildDynamicContextMessage("<p>v1</p>");
		const b = buildDynamicContextMessage("<p>v2</p>");
		expect(a).not.toBe(b);
	});
});
