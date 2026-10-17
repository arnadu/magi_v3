import { describe, expect, it } from "vitest";
import { callIndexFor } from "../src/call-index.js";

const asst = (callId: string | null) => ({
	callId,
	message: { role: "assistant" },
});
const tool = { callId: null, message: { role: "toolResult" } };
const user = { callId: null, message: { role: "user" } };

describe("callIndexFor", () => {
	it("joins by callId when both sides carry one, surviving an extra logged call", () => {
		// A retried/errored call "x" was logged but produced no top-level message.
		const calls = [{ callId: "a" }, { callId: "x" }, { callId: "b" }];
		expect(callIndexFor([user, asst("a"), tool, asst("b")], calls)).toEqual([
			-1, 0, -1, 2,
		]);
	});

	it("falls back to the positional rule for data written before ids existed", () => {
		const calls = [{ callId: null }, { callId: null }];
		expect(callIndexFor([user, asst(null), tool, asst(null)], calls)).toEqual([
			-1, 0, -1, 1,
		]);
	});

	it("returns -1 for an assistant message whose call was pruned or never logged", () => {
		expect(callIndexFor([asst("gone")], [{ callId: "a" }])).toEqual([-1]);
	});
});
