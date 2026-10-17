/**
 * Back-off for a turn that failed with an LLM error (402 in-flight budget,
 * 5xx, provider timeout): exponential from `baseMs`, capped at `maxMs`, or
 * the provider's own `Retry-After` when the error message carries one and it
 * is longer. A tight retry loop once produced 42 failed turns in 40 s
 * (2026-09-21); every one of them was a zero-output turn that raised an
 * anomaly and woke a copilot.
 */
export function failureBackoffMs(
	failures: number,
	errorMessage: string,
	opts: { baseMs?: number; maxMs?: number } = {},
): number {
	const baseMs = opts.baseMs ?? 30_000;
	const maxMs = opts.maxMs ?? 300_000;
	const exp = Math.min(baseMs * 2 ** Math.max(0, failures - 1), maxMs);
	const m = errorMessage.match(/Retry-After\D{0,8}(\d{1,5})/i);
	const retryAfterMs = m ? Number(m[1]) * 1000 : 0;
	return Math.max(exp, Math.min(retryAfterMs, 2 * maxMs));
}

interface AssistantLike {
	role: string;
	stopReason?: string;
	errorMessage?: string;
}

/**
 * Per-agent cooldown state for the orchestrator: `note` every message a run
 * reports, `active` before dispatching, and a timer re-dispatches when a
 * cooldown ends so the agent is picked up without new mail.
 */
export function createErrorCooldown(
	config: {
		errorCooldownMs?: (failures: number, errorMessage: string) => number;
	},
	redispatch: () => void,
) {
	const backoff = config.errorCooldownMs ?? failureBackoffMs;
	const streak = new Map<string, number>();
	const until = new Map<string, number>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	return {
		note(agentId: string, msg: AssistantLike): void {
			if (msg.role !== "assistant") return;
			if (msg.stopReason === "error") {
				const failures = (streak.get(agentId) ?? 0) + 1;
				streak.set(agentId, failures);
				const ms = backoff(failures, msg.errorMessage ?? "");
				until.set(agentId, Date.now() + ms);
				console.warn(
					`[orchestrator] ${agentId}: LLM error #${failures} — next dispatch no sooner than ${Math.round(ms / 1000)} s from now`,
				);
			} else {
				streak.delete(agentId);
				until.delete(agentId);
			}
		},
		active(agentId: string): boolean {
			const t = until.get(agentId);
			if (t === undefined) return false;
			const remaining = t - Date.now();
			if (remaining <= 0) {
				until.delete(agentId);
				return false;
			}
			if (!timers.has(agentId)) {
				const timer = setTimeout(() => {
					timers.delete(agentId);
					redispatch();
				}, remaining);
				timer.unref?.();
				timers.set(agentId, timer);
			}
			return true;
		},
		dispose(): void {
			for (const t of timers.values()) clearTimeout(t);
			timers.clear();
		},
	};
}
