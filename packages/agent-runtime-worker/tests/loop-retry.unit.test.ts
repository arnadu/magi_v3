import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { is429, isTransientError } from "../src/loop.js";

function errorMsg(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("isTransientError (issue #38)", () => {
	it("matches the real production incidents verbatim", () => {
		expect(
			isTransientError(errorMsg("Stream ended without finish_reason")),
		).toBe(true);
		expect(isTransientError(errorMsg("Upstream idle timeout exceeded"))).toBe(
			true,
		);
		expect(isTransientError(errorMsg("Connection error"))).toBe(true);
	});

	it("does not match a successful message", () => {
		const ok: AssistantMessage = {
			...errorMsg(""),
			stopReason: "stop",
			errorMessage: undefined,
		};
		expect(isTransientError(ok)).toBe(false);
	});

	it("does not match a 429 (handled separately by is429)", () => {
		expect(isTransientError(errorMsg("429 rate limit exceeded"))).toBe(false);
		expect(is429(errorMsg("429 rate limit exceeded"))).toBe(true);
	});

	it("does not match an unrelated, non-transient error", () => {
		expect(
			isTransientError(errorMsg("invalid_request_error: bad schema")),
		).toBe(false);
	});
});
