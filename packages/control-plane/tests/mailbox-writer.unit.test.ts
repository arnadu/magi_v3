import { describe, expect, it } from "vitest";
import { postMailbox } from "../src/mailbox-writer.js";

describe("postMailbox (MBX1)", () => {
	it("writes the daemon's mailbox document shape, deduplicating recipients", async () => {
		const inserted: Array<Record<string, unknown>> = [];
		const db = {
			collection: () => ({
				createIndex: async () => "idx",
				insertOne: async (doc: Record<string, unknown>) => {
					inserted.push(doc);
					return { acknowledged: true };
				},
			}),
		} as never;
		const msg = await postMailbox(db, {
			missionId: "m1",
			from: "system",
			to: ["lead", "user", "lead"],
			subject: "s",
			body: "b",
		});
		expect(inserted).toHaveLength(1);
		expect(inserted[0]).toMatchObject({
			missionId: "m1",
			from: "system",
			to: ["lead", "user"],
			subject: "s",
			body: "b",
			readBy: [],
		});
		expect(typeof inserted[0].id).toBe("string");
		expect(inserted[0].timestamp).toBeInstanceOf(Date);
		expect(msg.id).toBe(inserted[0].id);
	});
});
