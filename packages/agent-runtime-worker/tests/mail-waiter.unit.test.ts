/**
 * MW1: the mail waiter wakes on a poll fallback, not only on a Change Stream
 * event — an insert that lands before watch() is open is otherwise invisible
 * until the next insert.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createMailWaiter } from "../src/daemon-boot/mail-waiter.js";

function fakeCollection() {
	const streams: Array<
		EventEmitter & { close: () => Promise<void>; closed: boolean }
	> = [];
	const col = {
		watch() {
			const s = Object.assign(new EventEmitter(), {
				closed: false,
				close: async () => {
					s.closed = true;
				},
			});
			streams.push(s);
			return s;
		},
	};
	return { col: col as never, streams };
}

describe("createMailWaiter", () => {
	it("resolves on a change event and closes the stream", async () => {
		const { col, streams } = fakeCollection();
		const wait = createMailWaiter(
			col,
			"m1",
			new AbortController().signal,
			10_000,
		);
		const p = wait();
		streams[0].emit("change", {});
		await p;
		expect(streams[0].closed).toBe(true);
	});

	it("resolves after the poll fallback when no event arrives", async () => {
		const { col, streams } = fakeCollection();
		const wait = createMailWaiter(col, "m1", new AbortController().signal, 30);
		const t0 = Date.now();
		await wait();
		expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
		expect(streams[0].closed).toBe(true);
	});

	it("resolves immediately on abort", async () => {
		const { col } = fakeCollection();
		const ac = new AbortController();
		const wait = createMailWaiter(col, "m1", ac.signal, 10_000);
		const p = wait();
		ac.abort();
		await p;
	});
});
