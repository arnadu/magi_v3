import { describe, expect, it } from "vitest";
import {
	APP_SESSION_TTL_MS,
	type AppGrant,
	deriveAppsToken,
	signAppSession,
	signAppTicket,
	verifyAppSession,
	verifyAppTicket,
} from "../src/apps-signing.js";

const grant: AppGrant = {
	userId: "u1",
	missionId: "m1",
	app: "dash",
	capability: "0123456789abcdef0123456789abcdef",
	slot: 20003,
	machine: "fdaa::2",
};
const KEY = "ticket-key";
const NOW = 1_800_000_000_000;

describe("app tickets and sessions", () => {
	it("verify what was signed, with the same key, while unexpired", () => {
		const t = signAppTicket(grant, KEY, NOW);
		expect(verifyAppTicket(t, KEY, NOW + 59_000)).toMatchObject({
			...grant,
			kind: "ticket",
		});
		expect(verifyAppTicket(t, KEY, NOW + 60_000)).toBeNull();
		expect(verifyAppTicket(t, "other-key", NOW)).toBeNull();
		const s = signAppSession(grant, KEY, NOW);
		expect(
			verifyAppSession(s, KEY, NOW + APP_SESSION_TTL_MS - 1),
		).toMatchObject(grant);
		expect(verifyAppSession(s, KEY, NOW + APP_SESSION_TTL_MS)).toBeNull();
	});

	it("never accept a ticket as a session or a session as a ticket", () => {
		expect(
			verifyAppSession(signAppTicket(grant, KEY, NOW), KEY, NOW),
		).toBeNull();
		expect(
			verifyAppTicket(signAppSession(grant, KEY, NOW), KEY, NOW),
		).toBeNull();
	});

	it("refuse a tampered body, a forged signature, junk, and an empty key", () => {
		const t = signAppTicket(grant, KEY, NOW);
		const [body, sig] = t.split(".");
		const other = Buffer.from(
			JSON.stringify({
				...JSON.parse(Buffer.from(body, "base64url").toString()),
				slot: 20004,
			}),
		).toString("base64url");
		expect(verifyAppTicket(`${other}.${sig}`, KEY, NOW)).toBeNull();
		expect(verifyAppTicket(`${body}.AAAA`, KEY, NOW)).toBeNull();
		expect(verifyAppTicket("not-a-ticket", KEY, NOW)).toBeNull();
		expect(verifyAppTicket(`${t}.x`, KEY, NOW)).toBeNull();
		expect(verifyAppTicket(t, "", NOW)).toBeNull();
		expect(() => signAppTicket(grant, "", NOW)).toThrow(/no signing key/);
	});

	it("refuse a capability that is not 32 hex characters", () => {
		const t = signAppTicket({ ...grant, capability: "../../etc" }, KEY, NOW);
		expect(verifyAppTicket(t, KEY, NOW)).toBeNull();
	});
});

describe("deriveAppsToken", () => {
	it("is per mission, and never the monitor token's derivation", () => {
		expect(deriveAppsToken("k", "m1")).not.toBe(deriveAppsToken("k", "m2"));
		expect(deriveAppsToken("k", "m1")).toMatch(/^[0-9a-f]{64}$/);
		expect(deriveAppsToken("", "m1")).toBe("");
	});
});
