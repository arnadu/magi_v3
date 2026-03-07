import type { Usage } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Per-agent accumulator
// ---------------------------------------------------------------------------

interface AgentRecord {
	agentId: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	llmCalls: number;
}

/**
 * Accumulates LLM token usage across all agent turns in a mission.
 *
 * Call `add()` every time an AssistantMessage is received.
 * Use `callLine()` for a compact per-call console log entry.
 * Use `fullSummary()` on shutdown for the final roll-up.
 */
export class UsageAccumulator {
	private readonly perAgent = new Map<string, AgentRecord>();
	private missionCalls = 0;

	add(agentId: string, usage: Usage): void {
		const prev = this.perAgent.get(agentId) ?? {
			agentId,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			costUsd: 0,
			llmCalls: 0,
		};
		this.perAgent.set(agentId, {
			agentId,
			input: prev.input + usage.input,
			output: prev.output + usage.output,
			cacheRead: prev.cacheRead + usage.cacheRead,
			cacheWrite: prev.cacheWrite + usage.cacheWrite,
			costUsd: prev.costUsd + usage.cost.total,
			llmCalls: prev.llmCalls + 1,
		});
		this.missionCalls++;
	}

	totalCostUsd(): number {
		let total = 0;
		for (const a of this.perAgent.values()) total += a.costUsd;
		return total;
	}

	agents(): AgentRecord[] {
		return [...this.perAgent.values()].sort((a, b) => b.costUsd - a.costUsd);
	}

	/** One-liner logged to console after each LLM call. */
	callLine(agentId: string, usage: Usage): string {
		const agentTotal = this.perAgent.get(agentId)?.costUsd ?? 0;
		const parts: string[] = [
			`in=${usage.input.toLocaleString()}`,
			`out=${usage.output.toLocaleString()}`,
		];
		if (usage.cacheRead > 0)
			parts.push(`cache_r=${usage.cacheRead.toLocaleString()}`);
		if (usage.cacheWrite > 0)
			parts.push(`cache_w=${usage.cacheWrite.toLocaleString()}`);
		parts.push(
			`| call=$${usage.cost.total.toFixed(4)}`,
			`agent=$${agentTotal.toFixed(4)}`,
			`mission=$${this.totalCostUsd().toFixed(4)}`,
		);
		return `[usage:${agentId}] ${parts.join(" ")}`;
	}

	/** Full per-agent breakdown — log on shutdown. */
	fullSummary(): string {
		if (this.perAgent.size === 0) return "[usage] No LLM calls recorded.";
		const lines = ["[usage] Mission totals:"];
		for (const a of this.agents()) {
			lines.push(
				`  ${a.agentId.padEnd(22)}` +
					`in=${a.input.toLocaleString().padStart(8)}  ` +
					`out=${a.output.toLocaleString().padStart(7)}  ` +
					`cache=${a.cacheRead.toLocaleString().padStart(7)}  ` +
					`calls=${String(a.llmCalls).padStart(3)}  ` +
					`cost=$${a.costUsd.toFixed(4)}`,
			);
		}
		lines.push(
			`  ${"TOTAL".padEnd(22)}` +
				`${"".padStart(43)}` +
				`calls=${String(this.missionCalls).padStart(3)}  ` +
				`cost=$${this.totalCostUsd().toFixed(4)}`,
		);
		return lines.join("\n");
	}
}
