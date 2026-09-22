/**
 * Shared MongoDB Atlas storage usage (ADR-0032 Decision 2/4). No real
 * MongoDB — a fake `client`/`db` covering exactly the driver calls this
 * module makes (`admin().listDatabases()`, `db(name).command({dbStats})`,
 * `$collStats`).
 */

import type { AlertStateStore } from "@magi/agent-runtime-worker";
import type { Db, MongoClient } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import {
	type AtlasUsageDeps,
	checkAtlasStorage,
	readAtlasUsage,
} from "../src/atlas-usage.js";

interface FakeDbStats {
	dataSize: number;
	indexSize: number;
}

function fakeCluster(opts: {
	appDbName?: string;
	databases?: string[]; // non-system names returned by listDatabases; undefined = denied
	statsByDb?: Record<string, FakeDbStats>;
	collections?: Record<string, number>; // name -> storageStats.size, for the app db
	listDatabasesError?: Error;
}) {
	const appDbName = opts.appDbName ?? "magi_v3_dev";
	const statsByDb = opts.statsByDb ?? {};
	const collections = opts.collections ?? {};
	const platformResourcesDocs: Record<string, unknown>[] = [];
	const mailboxDocs: Record<string, unknown>[] = [];

	function dbFor(name: string): Db {
		return {
			databaseName: name,
			async command(cmd: { dbStats?: number }) {
				if (cmd.dbStats) {
					const s = statsByDb[name];
					if (!s) throw new Error(`no dbStats fixture for "${name}"`);
					return s;
				}
				throw new Error(`unexpected command on ${name}`);
			},
			listCollections() {
				return {
					toArray: async () =>
						Object.keys(collections).map((name) => ({ name })),
				};
			},
			collection(name: string) {
				return {
					aggregate() {
						return {
							toArray: async () => [
								{ storageStats: { size: collections[name] } },
							],
						};
					},
				};
			},
			// Only the app db is ever asked to persist/relay in these tests.
			async insertOneMailbox(doc: Record<string, unknown>) {
				mailboxDocs.push(doc);
			},
		} as unknown as Db;
	}

	const appDb = dbFor(appDbName);
	// Patch collection() on the app db so writes to platformResources/mailbox
	// land in the arrays above, while other collections keep the dbFor behavior.
	const originalCollection = appDb.collection.bind(appDb);
	(appDb as unknown as { collection: Db["collection"] }).collection = ((
		name: string,
	) => {
		if (name === "platformResources") {
			return {
				async updateOne(
					filter: { _id: string },
					update: { $set: Record<string, unknown> },
					opts2: unknown,
				) {
					platformResourcesDocs.push({ filter, set: update.$set, opts: opts2 });
				},
			};
		}
		if (name === "mailbox") {
			return {
				async insertOne(doc: Record<string, unknown>) {
					mailboxDocs.push(doc);
				},
			};
		}
		return originalCollection(name);
	}) as Db["collection"];

	const client = {
		db(name?: string) {
			if (name === undefined || name === appDbName) return appDb;
			return dbFor(name);
		},
	} as unknown as MongoClient;
	// admin() lives on the result of client.db() with no args, per the real driver.
	(client.db() as unknown as { admin: () => unknown }).admin = () => ({
		async listDatabases() {
			if (opts.listDatabasesError) throw opts.listDatabasesError;
			const names = [
				"admin",
				"local",
				"config",
				...(opts.databases ?? [appDbName]),
			];
			return { databases: names.map((name) => ({ name })) };
		},
	});

	return { client, db: appDb, platformResourcesDocs, mailboxDocs };
}

function fakeStore(): AlertStateStore & { puts: unknown[] } {
	const state = new Map<string, { level: string; lastAlertAt: Date }>();
	const puts: unknown[] = [];
	return {
		puts,
		async get(key) {
			const s = state.get(key);
			return s
				? { key, level: s.level as "soft" | "hard", lastAlertAt: s.lastAlertAt }
				: null;
		},
		async put(s) {
			state.set(s.key, s);
			puts.push(s);
		},
		async clear(key) {
			state.delete(key);
		},
	};
}

describe("readAtlasUsage", () => {
	it("sums dataSize + indexSize across every non-system database", async () => {
		const { client, db } = fakeCluster({
			databases: ["magi_v3_dev", "other_project"],
			statsByDb: {
				magi_v3_dev: {
					dataSize: 300 * 1024 * 1024,
					indexSize: 10 * 1024 * 1024,
				},
				other_project: { dataSize: 5 * 1024 * 1024, indexSize: 1024 * 1024 },
			},
		});
		const usage = await readAtlasUsage({ client, db });

		expect(usage.usedBytes).toBe(316 * 1024 * 1024);
		expect(usage.databases.map((d) => d.name).sort()).toEqual([
			"magi_v3_dev",
			"other_project",
		]);
		expect(usage.fellBackToAppDatabase).toBe(false);
	});

	it("excludes admin, local and config even though listDatabases returns them", async () => {
		const { client, db } = fakeCluster({
			databases: ["magi_v3_dev"],
			statsByDb: { magi_v3_dev: { dataSize: 1, indexSize: 1 } },
		});
		const usage = await readAtlasUsage({ client, db });
		expect(usage.databases.map((d) => d.name)).toEqual(["magi_v3_dev"]);
	});

	it("uses dataSize + indexSize, never storageSize", async () => {
		const { client, db } = fakeCluster({
			databases: ["magi_v3_dev"],
			statsByDb: {
				magi_v3_dev: {
					dataSize: 313 * 1024 * 1024,
					indexSize: 2 * 1024 * 1024,
				},
			},
		});
		const usage = await readAtlasUsage({ client, db });
		expect(usage.usedBytes).toBe(315 * 1024 * 1024);
	});

	it("falls back to the app database alone when listDatabases is denied", async () => {
		const { client, db } = fakeCluster({
			listDatabasesError: new Error("not authorized"),
			statsByDb: { magi_v3_dev: { dataSize: 100, indexSize: 10 } },
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const usage = await readAtlasUsage({ client, db });

		expect(usage.fellBackToAppDatabase).toBe(true);
		expect(usage.databases).toEqual([{ name: "magi_v3_dev", bytes: 110 }]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("denied"));
		warn.mockRestore();
	});

	it("computes the app database's collection breakdown, largest first, capped at 10", async () => {
		const collections: Record<string, number> = {};
		for (let i = 0; i < 15; i++) collections[`col${i}`] = i;
		const { client, db } = fakeCluster({
			databases: ["magi_v3_dev"],
			statsByDb: { magi_v3_dev: { dataSize: 1, indexSize: 1 } },
			collections,
		});
		const usage = await readAtlasUsage({ client, db });
		expect(usage.collections).toHaveLength(10);
		expect(usage.collections[0]).toEqual({ name: "col14", bytes: 14 });
	});

	it("applies the limit (default 512 MB, or a custom limitMb)", async () => {
		const { client, db } = fakeCluster({
			databases: ["magi_v3_dev"],
			statsByDb: { magi_v3_dev: { dataSize: 1, indexSize: 1 } },
		});
		expect((await readAtlasUsage({ client, db })).limitBytes).toBe(
			512 * 1024 * 1024,
		);
		expect(
			(await readAtlasUsage({ client, db, limitMb: 1024 })).limitBytes,
		).toBe(1024 * 1024 * 1024);
	});

	it("never throws when one database's dbStats fails — the rest still count", async () => {
		const { client, db } = fakeCluster({
			databases: ["magi_v3_dev", "broken_db"],
			statsByDb: { magi_v3_dev: { dataSize: 100, indexSize: 0 } },
			// "broken_db" has no fixture -> dbFor throws for it
		});
		const usage = await readAtlasUsage({ client, db });
		expect(usage.usedBytes).toBe(100);
		expect(usage.databases).toEqual([{ name: "magi_v3_dev", bytes: 100 }]);
	});
});

function baseDeps(over: Partial<AtlasUsageDeps> = {}): {
	deps: AtlasUsageDeps;
	cluster: ReturnType<typeof fakeCluster>;
	store: ReturnType<typeof fakeStore>;
} {
	const cluster = fakeCluster({
		databases: ["magi_v3_dev"],
		statsByDb: { magi_v3_dev: { dataSize: 100, indexSize: 0 } },
	});
	const store = fakeStore();
	const deps: AtlasUsageDeps = {
		client: cluster.client,
		db: cluster.db,
		limitMb: 1, // 1 MB, so tiny fixture byte counts can cross thresholds
		alertStore: store,
		platformAdminUserIds: ["admin-1", "admin-2"],
		...over,
	};
	return { deps, cluster, store };
}

describe("checkAtlasStorage", () => {
	it("persists usage to platformResources under _id: atlas", async () => {
		const { deps, cluster } = baseDeps();
		await checkAtlasStorage(deps);
		expect(cluster.platformResourcesDocs).toHaveLength(1);
		expect(cluster.platformResourcesDocs[0]).toMatchObject({
			filter: { _id: "atlas" },
			opts: { upsert: true },
		});
	});

	it("relays atlas-storage-high only to platform admins, only at the hard threshold", async () => {
		const bigCluster = fakeCluster({
			databases: ["magi_v3_dev"],
			// 0.9 MB / 1 MB limit = 90% -> hard (threshold 85%)
			statsByDb: {
				magi_v3_dev: { dataSize: 900 * 1024, indexSize: 0 },
			},
		});
		const store = fakeStore();
		await checkAtlasStorage({
			client: bigCluster.client,
			db: bigCluster.db,
			limitMb: 1,
			alertStore: store,
			platformAdminUserIds: ["admin-1", "admin-2"],
		});

		expect(bigCluster.mailboxDocs).toHaveLength(2);
		expect(bigCluster.mailboxDocs.map((d) => d.missionId).sort()).toEqual([
			"copilot-admin-1",
			"copilot-admin-2",
		]);
		for (const doc of bigCluster.mailboxDocs) {
			expect(doc).toMatchObject({
				from: "system",
				to: ["copilot"],
				subject: "Anomaly (hard): atlas-storage-high",
			});
		}
	});

	it("does not relay at the soft threshold — soft is report-only", async () => {
		const cluster = fakeCluster({
			databases: ["magi_v3_dev"],
			// 720 KB / 1 MB = ~70.3% -> soft (threshold 70%, hard is 85%)
			statsByDb: { magi_v3_dev: { dataSize: 720 * 1024, indexSize: 0 } },
		});
		await checkAtlasStorage({
			client: cluster.client,
			db: cluster.db,
			limitMb: 1,
			alertStore: fakeStore(),
			platformAdminUserIds: ["admin-1"],
		});
		expect(cluster.mailboxDocs).toHaveLength(0);
	});

	it("never relays when no platform admins are configured, and warns instead", async () => {
		const { deps, cluster } = baseDeps({ platformAdminUserIds: [] });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await checkAtlasStorage(deps);
		expect(cluster.mailboxDocs).toHaveLength(0);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("PLATFORM_ADMIN_USER_IDS"),
		);
		warn.mockRestore();
	});

	it("still persists the sample even when relaying to an admin fails", async () => {
		const bigCluster = fakeCluster({
			databases: ["magi_v3_dev"],
			statsByDb: { magi_v3_dev: { dataSize: 950 * 1024, indexSize: 0 } },
		});
		bigCluster.db.collection = ((name: string) => {
			if (name === "mailbox") {
				return {
					async insertOne() {
						throw new Error("mailbox insert failed");
					},
				};
			}
			if (name === "platformResources") {
				return {
					async updateOne(
						filter: { _id: string },
						update: { $set: Record<string, unknown> },
					) {
						bigCluster.platformResourcesDocs.push({ filter, set: update.$set });
					},
				};
			}
			return { listCollections: () => ({ toArray: async () => [] }) } as never;
		}) as Db["collection"];

		await expect(
			checkAtlasStorage({
				client: bigCluster.client,
				db: bigCluster.db,
				limitMb: 1,
				alertStore: fakeStore(),
				platformAdminUserIds: ["admin-1"],
			}),
		).resolves.toBeUndefined();
		expect(bigCluster.platformResourcesDocs).toHaveLength(1);
	});

	it("never throws when the Mongo write itself fails", async () => {
		const { deps, cluster } = baseDeps();
		cluster.db.collection = (() => {
			throw new Error("mongo down");
		}) as unknown as Db["collection"];
		await expect(checkAtlasStorage(deps)).resolves.toBeUndefined();
	});
});
