/**
 * Which logged LLM call belongs to which top-level assistant message.
 *
 * Joined by `callId` when both sides carry one (written by the inner loop
 * since the TX1 fix). Older turns fall back to the positional rule — the k-th
 * assistant message is the k-th call — which drifts whenever a retry, an
 * errored call or a Research sub-loop logged a call that produced no
 * top-level message.
 */
export function callIndexFor(
	topLevel: ReadonlyArray<{ callId: string | null; message: { role: string } }>,
	calls: ReadonlyArray<{ callId: string | null }>,
): number[] {
	const byId = new Map<string, number>();
	calls.forEach((c, i) => {
		if (c.callId) byId.set(c.callId, i);
	});
	let asstSeq = -1;
	return topLevel.map((e) => {
		if (e.message.role !== "assistant") return -1;
		asstSeq++;
		if (e.callId) {
			const i = byId.get(e.callId);
			return i === undefined ? -1 : i;
		}
		return asstSeq;
	});
}
