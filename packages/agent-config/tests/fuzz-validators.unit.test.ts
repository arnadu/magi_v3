/**
 * Property-based fuzzing (security assurance plan, part 4) of two validators the control plane
 * trusts: team-file paths (written to disk at every mission boot) and the apps host's signed
 * tickets and sessions. Fixed seed; FAST_CHECK_SEED=<n> explores elsewhere.
 */
import { isAbsolute, relative, resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
	APP_SESSION_TTL_MS,
	APP_TICKET_TTL_MS,
	type AppGrant,
	signAppSession,
	signAppTicket,
	verifyAppSession,
	verifyAppTicket,
} from "../src/apps-signing.js";
import { validateTeamFilePath } from "../src/team-files.js";

// Properties run hundreds of cases: under the parallel suite they need more than the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

const RUNS = {
	seed: Number(process.env.FAST_CHECK_SEED ?? 20261124),
	numRuns: 500,
};

describe("an accepted team-file path always lands inside the team directory", () => {
	it("for any mix of segments, separators, NULs and arbitrary text", () => {
		const segment = fc.constantFrom(
			"a",
			"b.md",
			"..",
			".",
			"",
			"~",
			"%2e%2e",
			"a\\..\\..",
			"\0",
			" ",
			"...",
		);
		const path = fc.oneof(
			fc
				.tuple(
					fc.constantFrom("", "/", "./", "//"),
					fc.array(segment, { minLength: 1, maxLength: 6 }),
				)
				.map(([prefix, segs]) => prefix + segs.join("/")),
			fc.string(),
		);
		const teamDir = "/srv/missions/m/team";
		let accepted = 0;
		fc.assert(
			fc.property(path, (p) => {
				try {
					validateTeamFilePath(p);
				} catch {
					return true;
				}
				accepted++;
				const rel = relative(teamDir, resolve(teamDir, p));
				return (
					!p.includes("\0") &&
					!isAbsolute(rel) &&
					rel !== ".." &&
					!rel.startsWith("../")
				);
			}),
			RUNS,
		);
		expect(accepted).toBeGreaterThan(0);
	});
});

describe("an apps ticket or session verifies only as itself, unaltered, in time, under its key", () => {
	const KEY = "k".repeat(64);
	const NOW = Date.parse("2026-11-24T12:00:00Z");
	const grant: fc.Arbitrary<AppGrant> = fc.record({
		userId: fc.string({ minLength: 1, maxLength: 30 }),
		missionId: fc.string({ minLength: 1, maxLength: 30 }),
		app: fc.string({ minLength: 1, maxLength: 40 }),
		capability: fc.stringMatching(/^[0-9a-f]{32}$/),
		slot: fc.integer({ min: 20000, max: 20099 }),
		machine: fc.constantFrom("fdaa:0:1::2", "10.0.0.5", "[::1]"),
	});
	const sameGrant = (g: AppGrant, v: AppGrant | null) =>
		v !== null &&
		v.userId === g.userId &&
		v.missionId === g.missionId &&
		v.app === g.app &&
		v.capability === g.capability &&
		v.slot === g.slot &&
		v.machine === g.machine;

	it("round-trips, and is refused as the other kind, under another key, or once expired", () => {
		fc.assert(
			fc.property(grant, (g) => {
				const t = signAppTicket(g, KEY, NOW);
				const s = signAppSession(g, KEY, NOW);
				return (
					sameGrant(g, verifyAppTicket(t, KEY, NOW)) &&
					sameGrant(g, verifyAppSession(s, KEY, NOW)) &&
					verifyAppSession(t, KEY, NOW) === null &&
					verifyAppTicket(s, KEY, NOW) === null &&
					verifyAppTicket(t, `${KEY}x`, NOW) === null &&
					verifyAppSession(s, "", NOW) === null &&
					verifyAppTicket(t, KEY, NOW + APP_TICKET_TTL_MS) === null &&
					verifyAppSession(s, KEY, NOW + APP_SESSION_TTL_MS) === null
				);
			}),
			RUNS,
		);
	});

	it("is refused after any one-character change, insertion or deletion", () => {
		const alphabet =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.=+/ ";
		const edit = fc.record({
			at: fc.nat(),
			op: fc.constantFrom("replace", "insert", "delete"),
			ch: fc.constantFrom(...alphabet),
			kind: fc.constantFrom("ticket", "session"),
		});
		fc.assert(
			fc.property(grant, edit, (g, e) => {
				const token =
					e.kind === "ticket"
						? signAppTicket(g, KEY, NOW)
						: signAppSession(g, KEY, NOW);
				const i = e.at % token.length;
				const changed =
					e.op === "replace"
						? token.slice(0, i) + e.ch + token.slice(i + 1)
						: e.op === "insert"
							? token.slice(0, i) + e.ch + token.slice(i)
							: token.slice(0, i) + token.slice(i + 1);
				if (changed === token) return true;
				const v =
					e.kind === "ticket"
						? verifyAppTicket(changed, KEY, NOW)
						: verifyAppSession(changed, KEY, NOW);
				return v === null;
			}),
			RUNS,
		);
	});
});
