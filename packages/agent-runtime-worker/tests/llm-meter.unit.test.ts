import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
	createLogOnlyMeter,
	type LlmCallEvent,
	meteredCompleteSimple,
	stripImageData,
} from "../src/llm-meter.js";
import { CLAUDE_HAIKU } from "../src/models.js";
import { withOcrPageCap } from "../src/ocr-cap.js";

function response(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "a cat" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: CLAUDE_HAIKU.id,
		usage: {
			input: 1_000,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_050,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const imageMessage = {
	role: "user" as const,
	timestamp: 1,
	content: [
		{ type: "text" as const, text: "describe" },
		{
			type: "image" as const,
			data: "AAAA".repeat(10_000),
			mimeType: "image/png",
		},
	],
};

describe("meteredCompleteSimple (COST-1)", () => {
	it("calls the meter with the answering model and the response", async () => {
		const events: LlmCallEvent[] = [];
		const out = await meteredCompleteSimple(
			CLAUDE_HAIKU,
			{ messages: [imageMessage] },
			undefined,
			async (e) => {
				events.push(e);
			},
			async () => response(),
		);
		expect(out.stopReason).toBe("stop");
		expect(events).toHaveLength(1);
		expect(events[0].model?.id).toBe(CLAUDE_HAIKU.id);
		expect(events[0].response.usage.input).toBe(1_000);
	});

	it("still returns the response when the meter itself throws", async () => {
		const out = await meteredCompleteSimple(
			CLAUDE_HAIKU,
			{ messages: [imageMessage] },
			undefined,
			async () => {
				throw new Error("mongo down");
			},
			async () => response(),
		);
		expect(out.stopReason).toBe("stop");
	});

	it("works without a meter", async () => {
		const out = await meteredCompleteSimple(
			CLAUDE_HAIKU,
			{ messages: [imageMessage] },
			undefined,
			undefined,
			async () => response(),
		);
		expect(out.stopReason).toBe("stop");
	});
});

describe("stripImageData", () => {
	it("replaces image blocks with a marker and leaves everything else", () => {
		const [m] = stripImageData([imageMessage]);
		expect(JSON.stringify(m)).not.toContain("AAAAAAAA");
		expect(m.content).toEqual([
			{ type: "text", text: "describe" },
			{ type: "text", text: "[image omitted from log]" },
		]);
		const plain = { role: "user" as const, timestamp: 1, content: "hi" };
		expect(stripImageData([plain])[0]).toBe(plain);
	});
});

describe("createLogOnlyMeter", () => {
	it("appends a priced, image-free entry under the synthetic agent id", async () => {
		const appended: unknown[] = [];
		const meter = createLogOnlyMeter(
			{ append: async (e) => void appended.push(e) },
			"m1",
			"operator-upload",
		);
		await meter({
			systemPrompt: "",
			messages: [imageMessage],
			toolNames: [],
			response: response(),
			model: CLAUDE_HAIKU,
		});
		expect(appended).toHaveLength(1);
		const entry = appended[0] as {
			agentId: string;
			model: string;
			usage: { cost: { totalCostUsd: number } };
			input: { messages: unknown[] };
		};
		expect(entry.agentId).toBe("operator-upload");
		expect(entry.model).toBe(CLAUDE_HAIKU.id);
		expect(entry.usage.cost.totalCostUsd).toBeGreaterThan(0);
		expect(JSON.stringify(entry.input.messages)).not.toContain("AAAAAAAA");
	});
});

describe("withOcrPageCap (DOC8)", () => {
	it("stops calling the vision model after the per-document cap", async () => {
		let calls = 0;
		const capped = withOcrPageCap(async () => {
			calls++;
			return "text";
		}, 2);
		expect(await capped(Buffer.from("a"), "image/png")).toBe("text");
		expect(await capped(Buffer.from("b"), "image/png")).toBe("text");
		expect(await capped(Buffer.from("c"), "image/png")).toBeUndefined();
		expect(await capped(Buffer.from("d"), "image/png")).toBeUndefined();
		expect(calls).toBe(2);
	});
});
