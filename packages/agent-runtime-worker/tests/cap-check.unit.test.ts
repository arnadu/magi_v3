/**
 * OC1: the per-call mission spend-cap check alerts once per breach window
 * (not once per LLM call) and stops failing open when it cannot read the
 * spend.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	CAP_CHECK_FAIL_CLOSED_AFTER,
	createOnAgentMessage,
} from "../src/daemon-boot/orchestration-callbacks.js";

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function harness(opts: { spend: number | Error; cap: number | undefined }) {
	const posts: unknown[] = [];
	const anomalies: unknown[] = [];
	const pauses: unknown[] = [];
	const ctx = {
		usageAccumulator: {
			add: () => {},
			callLine: () => "",
			agents: () => [],
			totalCostUsd: () => 0,
		},
		monitor: {
			push: () => {},
			notifyCostPause: async (total: number, cap: number) => {
				pauses.push([total, cap]);
			},
		},
		statsCollector: {
			readMissionSnapshot: async () => {
				if (opts.spend instanceof Error) throw opts.spend;
				return [{ lifetimeCostUsd: opts.spend, turnCostUsd: 0 }];
			},
		},
		missionId: "m1",
		missionConfigRepo: {
			readTeamConfig: async () => ({ mission: { maxCostUsd: opts.cap } }),
		},
		maxCostUsd: null,
		anomalyRecorder: { record: async (a: unknown) => void anomalies.push(a) },
		mailboxRepo: { post: async (p: unknown) => void posts.push(p) },
	};
	const onMessage = createOnAgentMessage(ctx as never);
	return { onMessage, posts, anomalies, pauses };
}

describe("mission cap check", () => {
	it("alerts once per breach window even when many calls arrive over the cap", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const h = harness({ spend: 10, cap: 5 });
		for (let i = 0; i < 5; i++) await h.onMessage("a", assistant());
		expect(h.pauses).toHaveLength(5); // the pause itself is idempotent and always requested
		expect(h.posts).toHaveLength(1);
		expect(h.anomalies).toHaveLength(1);
	});

	it("fails closed after repeated check failures instead of spending blind", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const h = harness({ spend: new Error("mongo down"), cap: 5 });
		for (let i = 0; i < CAP_CHECK_FAIL_CLOSED_AFTER - 1; i++) {
			await h.onMessage("a", assistant());
		}
		expect(h.pauses).toHaveLength(0);
		await h.onMessage("a", assistant());
		expect(h.pauses).toHaveLength(1);
		expect(h.posts).toHaveLength(1);
		expect(String((h.posts[0] as { subject: string }).subject)).toMatch(
			/cannot be verified/,
		);
	});

	it("does nothing special under the cap", async () => {
		const h = harness({ spend: 1, cap: 5 });
		await h.onMessage("a", assistant());
		expect(h.pauses).toHaveLength(0);
		expect(h.posts).toHaveLength(0);
	});
});
