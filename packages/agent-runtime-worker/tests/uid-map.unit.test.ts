/**
 * The volume's uid map (daemon-boot/uid-map.ts) and the stale-grant scan of a
 * private workdir's ACL (workspace-manager.ts): an agent keeps its uid across
 * boots whatever the roster's order, and a workdir grants only its agent and
 * the daemon.
 */
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	planUids,
	readUidMap,
	seedFromVolume,
	UID_MAP_FILE,
	writeUidMap,
} from "../src/daemon-boot/uid-map.js";
import { staleUserGrants } from "../src/workspace-manager.js";

const none = () => undefined;
const free = () => false;

describe("planUids", () => {
	it("assigns uids from 1001 in roster order on a new volume", () => {
		const plan = planUids({}, ["b", "a"], none, free);
		expect(plan.create).toEqual([
			{ user: "b", uid: 1001 },
			{ user: "a", uid: 1002 },
		]);
		expect(plan.map).toEqual({ b: 1001, a: 1002 });
	});

	it("keeps pinned uids whatever the order, and never reuses a departed agent's uid", () => {
		const stored = { appsec: 1001, gone: 1002, documenter: 1003 };
		const plan = planUids(stored, ["new", "documenter", "appsec"], none, free);
		expect(plan.create).toEqual([
			{ user: "new", uid: 1004 },
			{ user: "documenter", uid: 1003 },
			{ user: "appsec", uid: 1001 },
		]);
		expect(plan.map.gone).toBe(1002);
	});

	it("skips a uid another account holds", () => {
		const plan = planUids({}, ["a"], none, (uid) => uid === 1001);
		expect(plan.create).toEqual([{ user: "a", uid: 1002 }]);
	});

	it("records an existing user's uid and flags one that differs from its pin", () => {
		const uids: Record<string, number> = { copilot: 60011, documenter: 1004 };
		const plan = planUids(
			{ documenter: 1003 },
			["copilot", "documenter"],
			(u) => uids[u],
			free,
		);
		expect(plan.map.copilot).toBe(60011);
		expect(plan.create).toEqual([]);
		expect(plan.mismatched).toEqual([
			{ user: "documenter", pinned: 1003, actual: 1004 },
		]);
	});

	it("numbers new agents within the range, past the image's own users", () => {
		const plan = planUids({ copilot: 60011, appsec: 1001 }, ["a"], none, free);
		expect(plan.create).toEqual([{ user: "a", uid: 1002 }]);
		expect(() => planUids({ x: 59999 }, ["a"], none, free)).toThrow(
			/No agent uid left/,
		);
	});
});

describe("readUidMap / writeUidMap", () => {
	it("round-trips, private to the daemon", () => {
		const dir = mkdtempSync(join(tmpdir(), "uid-map-"));
		expect(readUidMap(dir)).toEqual({});
		writeUidMap(dir, { appsec: 1001 });
		expect(readUidMap(dir)).toEqual({ appsec: 1001 });
		expect(statSync(join(dir, UID_MAP_FILE)).mode & 0o777).toBe(0o600);
	});

	it("refuses a malformed map rather than guessing", () => {
		const dir = mkdtempSync(join(tmpdir(), "uid-map-"));
		writeFileSync(join(dir, UID_MAP_FILE), JSON.stringify({ appsec: 0 }));
		expect(() => readUidMap(dir)).toThrow(/invalid entry/);
	});
});

/** A home tree whose top-level workdir entries are owned as `owners` says. */
function volume(owners: Record<string, Record<string, number>>) {
	const home = mkdtempSync(join(tmpdir(), "uid-seed-"));
	const uidOf = new Map<string, number>();
	for (const [user, entries] of Object.entries(owners)) {
		const dir = join(home, user, "missions", "m1");
		mkdirSync(dir, { recursive: true });
		for (const [name, uid] of Object.entries(entries)) {
			mkdirSync(join(dir, name));
			uidOf.set(join(dir, name), uid);
		}
	}
	return { home, ownerOf: (p: string) => uidOf.get(p) ?? 999 };
}

describe("seedFromVolume", () => {
	it("reads each agent's uid from its own files, as on a volume whose uids had swapped", () => {
		const { home, ownerOf } = volume({
			documenter: { repos: 1003, "report-gate-tree": 1003, skills: 999 },
			"qa-lead": { repos: 1004, skills: 999 },
			appsec: { repos: 1001, review: 1001 },
		});
		const { seed, observed } = seedFromVolume(
			home,
			["appsec", "qa-lead", "documenter", "newcomer"],
			ownerOf,
		);
		expect(seed).toEqual({ documenter: 1003, "qa-lead": 1004, appsec: 1001 });
		expect([...observed].sort()).toEqual([1001, 1003, 1004]);
	});

	it("keeps a newcomer off every uid a file is owned by", () => {
		const { home, ownerOf } = volume({ gone: { repos: 1001 } });
		const { seed, observed } = seedFromVolume(home, ["newcomer"], ownerOf);
		const plan = planUids(seed, ["newcomer"], none, (u) => observed.has(u));
		expect(plan.create).toEqual([{ user: "newcomer", uid: 1002 }]);
	});

	it("refuses to guess on a tie or when two agents' files name one uid", () => {
		const tie = volume({ a: { x: 1001, y: 1002 } });
		expect(() => seedFromVolume(tie.home, ["a"], tie.ownerOf)).toThrow(
			/Cannot tell a's uid/,
		);
		const shared = volume({ a: { x: 1001 }, b: { y: 1001 } });
		expect(() =>
			seedFromVolume(shared.home, ["a", "b"], shared.ownerOf),
		).toThrow(/both belong to uid 1001/);
	});
});

describe("staleUserGrants", () => {
	it("lists every named uid, access or default, that is not allowed", () => {
		const listing = [
			"user::rwx",
			"user:1003:rwx",
			"user:1004:rwx",
			"group::---",
			"mask::rwx",
			"other::---",
			"default:user::rwx",
			"default:user:999:rwx",
			"default:user:1003:rwx",
			"default:user:1005:rwx",
		].join("\n");
		expect(staleUserGrants(listing, [1003, 999]).sort()).toEqual([1004, 1005]);
	});
});
