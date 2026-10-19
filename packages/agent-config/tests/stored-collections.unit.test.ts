/**
 * The collection-name map is the single source of names: storedCollection
 * resolves through it, and CLAUDE.md's storage list must name exactly the
 * same collections (a documented claim, so it is tested).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import {
	COLLECTION_NAMES,
	PER_MISSION_COLLECTIONS,
	storedCollection,
} from "../src/index.js";

const ROOT = join(__dirname, "..", "..", "..");

function documentedCollections(): string[] {
	const md = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
	const section = md
		.split("### Storage (MongoDB collections)")[1]
		.split("\n### ")[0];
	return [...section.matchAll(/^- `([A-Za-z_]+)` —/gm)].map((m) => m[1]);
}

describe("stored collections", () => {
	it("storedCollection resolves the key through COLLECTION_NAMES", () => {
		const asked: string[] = [];
		const db = {
			collection: (name: string) => {
				asked.push(name);
				return { name };
			},
		} as unknown as Db;
		storedCollection(db, "scheduledMessages");
		expect(asked).toEqual(["scheduled_messages"]);
	});

	it("names are unique", () => {
		const names = Object.values(COLLECTION_NAMES);
		expect(new Set(names).size).toBe(names.length);
	});

	it("CLAUDE.md lists exactly the collections in COLLECTION_NAMES", () => {
		expect(documentedCollections().sort()).toEqual(
			Object.values(COLLECTION_NAMES).sort(),
		);
	});

	it("per-mission collections are known keys", () => {
		for (const key of PER_MISSION_COLLECTIONS) {
			expect(COLLECTION_NAMES[key]).toBeTruthy();
		}
	});
});
