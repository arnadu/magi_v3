import { type Db, MongoClient } from "mongodb";

export interface MongoConnection {
	client: MongoClient;
	db: Db;
}

/**
 * Open a shared MongoDB connection. The caller is responsible for calling
 * client.close() on shutdown.
 *
 * When dbName is omitted, the database is read from the URI path (e.g.
 * `mongodb+srv://host/magi_v3_dev`). Pass an explicit dbName to override.
 */
export async function connectMongo(
	uri: string,
	dbName?: string,
): Promise<MongoConnection> {
	// serverSelectionTimeoutMS: fail fast if Atlas is unreachable (e.g. no DNS).
	// connectTimeoutMS: individual TCP handshake timeout.
	// ignoreUndefined: without this, the driver's default BSON serialization
	// turns any `undefined`-valued field in an insertOne document or a $set
	// update into a literal stored `null` — found live via ADR-0021's
	// structured-config migration, where `missionCopilotLimits: undefined`
	// (the normal "not configured" case) was silently persisted as `null`,
	// which then failed Zod's `.optional()` (not `.nullable()`) validation on
	// every subsequent read. Root-caused here once, application-wide, rather
	// than requiring every insertOne/$set call site to remember to omit
	// undefined keys itself.
	const client = new MongoClient(uri, {
		serverSelectionTimeoutMS: 10_000,
		connectTimeoutMS: 10_000,
		ignoreUndefined: true,
	});
	await client.connect();
	return { client, db: dbName ? client.db(dbName) : client.db() };
}
