/**
 * Per-client failed-authentication limiter (AUTH-BF). The admin path compares
 * the presented credential against `CONTROL_API_KEY` in constant time, but
 * nothing stopped an unlimited guessing rate; a client that fails this many
 * times in a window is answered 429 until the window passes.
 */

export interface FailedAuthLimiterOptions {
	maxFailures?: number;
	windowMs?: number;
	now?: () => number;
	/** Bound on tracked clients; the oldest entry is evicted beyond it. */
	maxEntries?: number;
}

export class FailedAuthLimiter {
	private readonly entries = new Map<
		string,
		{ failures: number; windowStart: number }
	>();
	private readonly maxFailures: number;
	private readonly windowMs: number;
	private readonly now: () => number;
	private readonly maxEntries: number;

	constructor(opts: FailedAuthLimiterOptions = {}) {
		this.maxFailures = opts.maxFailures ?? 20;
		this.windowMs = opts.windowMs ?? 60_000;
		this.now = opts.now ?? Date.now;
		this.maxEntries = opts.maxEntries ?? 10_000;
	}

	/** True while the client has exhausted its failures for the current window. */
	isBlocked(client: string): boolean {
		const e = this.entries.get(client);
		if (!e) return false;
		if (this.now() - e.windowStart >= this.windowMs) {
			this.entries.delete(client);
			return false;
		}
		return e.failures >= this.maxFailures;
	}

	/** Record a failed attempt. */
	fail(client: string): void {
		const t = this.now();
		const e = this.entries.get(client);
		if (!e || t - e.windowStart >= this.windowMs) {
			if (this.entries.size >= this.maxEntries) {
				const oldest = this.entries.keys().next().value;
				if (oldest !== undefined) this.entries.delete(oldest);
			}
			this.entries.set(client, { failures: 1, windowStart: t });
			return;
		}
		e.failures++;
	}

	/** Seconds until the client's window resets (for Retry-After). */
	retryAfterSeconds(client: string): number {
		const e = this.entries.get(client);
		if (!e) return 0;
		return Math.max(
			1,
			Math.ceil((e.windowStart + this.windowMs - this.now()) / 1000),
		);
	}
}
