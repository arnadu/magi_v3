/**
 * Shared MongoDB Atlas storage usage (ADR-0032 Decision 2/4). Cluster-wide,
 * not per-mission — the M0 quota counts "uncompressed BSON documents … plus
 * … associated indexes" (Atlas docs), i.e. `dataSize + indexSize` summed
 * across every database, **not** `storageSize` (compressed figures
 * understate real usage against the quota by roughly half — verified on the
 * dev cluster: 155 MB `storageSize` vs 313 MB `dataSize` for the app
 * database alone).
 *
 * Runs from the control plane's 5-min resource-monitor tick, never per
 * request. A failure never breaks the tick — every step here is wrapped and
 * logged, matching the daemon-side resource-sampler's fail-open posture.
 */

import { randomUUID } from "node:crypto";
import {
	type AlertStateStore,
	ATLAS_STORAGE,
	ATLAS_STORAGE_LIMIT_MB_DEFAULT,
	createMongoAlertStateStore,
	evaluateAlert,
} from "@magi/agent-runtime-worker";
import type { Db, MongoClient } from "mongodb";

const SYSTEM_DATABASES = new Set(["admin", "local", "config"]);
const MAX_COLLECTIONS = 10;

export interface DatabaseUsage {
	name: string;
	bytes: number;
}

export interface AtlasUsage {
	usedBytes: number;
	limitBytes: number;
	/** Every non-system database on the cluster; just the app database if listing was denied. */
	databases: DatabaseUsage[];
	/** The app database's own collections, largest first. */
	collections: DatabaseUsage[];
	/** True if `listDatabases` was denied and this fell back to the app database alone. */
	fellBackToAppDatabase: boolean;
}

export interface AtlasUsageDeps {
	client: MongoClient;
	/** The app's own connected database (used for the collection breakdown and as the fallback). */
	db: Db;
	/** Defaults to `ATLAS_STORAGE_LIMIT_MB` env, else 512 (the M0 default). */
	limitMb?: number;
	/** Injected for tests; defaults to a real Mongo-backed store. */
	alertStore?: AlertStateStore;
	/** Recipients for the `atlas-storage-high` relay — `PLATFORM_ADMIN_USER_IDS`, parsed by the caller. */
	platformAdminUserIds: string[];
}

/** Non-system database names on the cluster, or null if `listDatabases` is denied. */
async function listNonSystemDatabaseNames(
	client: MongoClient,
): Promise<string[] | null> {
	try {
		const result = await client.db().admin().listDatabases({ nameOnly: true });
		return result.databases
			.map((d) => d.name)
			.filter((name) => !SYSTEM_DATABASES.has(name));
	} catch {
		return null;
	}
}

/** `dataSize + indexSize` for one database, in bytes. */
async function dbDataPlusIndexBytes(
	client: MongoClient,
	name: string,
): Promise<number> {
	const stats = (await client.db(name).command({ dbStats: 1, scale: 1 })) as {
		dataSize: number;
		indexSize: number;
	};
	return stats.dataSize + stats.indexSize;
}

/** The app database's own collections, largest first, using `$collStats` (uncompressed size). */
async function appDatabaseCollectionSizes(db: Db): Promise<DatabaseUsage[]> {
	const names = await db.listCollections({}, { nameOnly: true }).toArray();
	const sizes: DatabaseUsage[] = [];
	for (const { name } of names) {
		try {
			const [row] = await db
				.collection(name)
				.aggregate<{ storageStats: { size: number } }>([
					{ $collStats: { storageStats: { scale: 1 } } },
				])
				.toArray();
			if (row) sizes.push({ name, bytes: row.storageStats.size });
		} catch (e) {
			console.error(
				`[atlas-usage] $collStats failed { collection: "${name}", error: "${(e as Error).message}" }`,
			);
		}
	}
	return sizes.sort((a, b) => b.bytes - a.bytes).slice(0, MAX_COLLECTIONS);
}

/** Reads the current cluster-wide usage. Never throws. */
export async function readAtlasUsage(
	deps: Pick<AtlasUsageDeps, "client" | "db" | "limitMb">,
): Promise<AtlasUsage> {
	const { client, db } = deps;
	const limitBytes =
		(deps.limitMb ?? ATLAS_STORAGE_LIMIT_MB_DEFAULT) * 1024 * 1024;

	const names = await listNonSystemDatabaseNames(client);
	const fellBackToAppDatabase = names === null;
	const targets = names ?? [db.databaseName];
	if (fellBackToAppDatabase) {
		console.warn(
			"[atlas-usage] listDatabases denied — falling back to the app database alone; the cluster-wide figure will understate real usage",
		);
	}

	const databases: DatabaseUsage[] = [];
	for (const name of targets) {
		try {
			databases.push({ name, bytes: await dbDataPlusIndexBytes(client, name) });
		} catch (e) {
			console.error(
				`[atlas-usage] dbStats failed { database: "${name}", error: "${(e as Error).message}" }`,
			);
		}
	}

	const collections = await appDatabaseCollectionSizes(db).catch((e) => {
		console.error(
			`[atlas-usage] Collection breakdown failed: ${(e as Error).message}`,
		);
		return [];
	});

	return {
		usedBytes: databases.reduce((sum, d) => sum + d.bytes, 0),
		limitBytes,
		databases,
		collections,
		fellBackToAppDatabase,
	};
}

/**
 * Read the current usage, persist it to `platformResources`, and — over
 * threshold — relay `atlas-storage-high` to every configured platform admin.
 * There is no mission to attach this to, so it bypasses `AnomalyRecorder`
 * (which is always mission-scoped) and posts directly.
 */
export async function checkAtlasStorage(deps: AtlasUsageDeps): Promise<void> {
	const usage = await readAtlasUsage(deps);

	try {
		await deps.db.collection("platformResources").updateOne(
			{ _id: "atlas" as unknown as never },
			{
				$set: {
					usedBytes: usage.usedBytes,
					limitBytes: usage.limitBytes,
					databases: usage.databases,
					collections: usage.collections,
					updatedAt: new Date(),
				},
			},
			{ upsert: true },
		);
	} catch (e) {
		console.error(
			`[atlas-usage] Failed to store usage: ${(e as Error).message}`,
		);
	}

	if (deps.platformAdminUserIds.length === 0) {
		console.warn(
			"[atlas-usage] PLATFORM_ADMIN_USER_IDS is empty — no atlas-storage-high alerts and no Atlas section in the daily report will ever be sent",
		);
		return;
	}
	if (usage.limitBytes === 0) return;

	const alertStore = deps.alertStore ?? createMongoAlertStateStore(deps.db);
	const ratio = usage.usedBytes / usage.limitBytes;
	let level: "soft" | "hard" | null;
	try {
		level = await evaluateAlert(
			alertStore,
			"platform:atlas-storage",
			ratio,
			ATLAS_STORAGE,
		);
	} catch (e) {
		console.error(
			`[atlas-usage] Alert evaluation failed: ${(e as Error).message}`,
		);
		return;
	}
	// Soft is report-only (ADR-0032 Decision 4) — only hard is relayed live.
	if (level !== "hard") return;

	const pct = Math.round(ratio * 100);
	const gb = (n: number) => (n / 1024 ** 3).toFixed(2);
	const largest = usage.collections
		.slice(0, 3)
		.map((c) => `${c.name} (${gb(c.bytes)} GB)`)
		.join(", ");
	const message = `Shared MongoDB Atlas cluster is at ${pct}% (${gb(usage.usedBytes)} / ${gb(usage.limitBytes)} GB) across ${usage.databases.length} database(s).${largest ? ` Largest collections in the app database: ${largest}.` : ""}`;

	for (const userId of deps.platformAdminUserIds) {
		try {
			await deps.db.collection("mailbox").insertOne({
				id: randomUUID(),
				missionId: `copilot-${userId}`,
				from: "system",
				to: ["copilot"],
				subject: "Anomaly (hard): atlas-storage-high",
				body: message,
				timestamp: new Date(),
				readBy: [],
			});
		} catch (e) {
			console.error(
				`[atlas-usage] Failed to relay to admin { userId: "${userId}", error: "${(e as Error).message}" }`,
			);
		}
	}
}
