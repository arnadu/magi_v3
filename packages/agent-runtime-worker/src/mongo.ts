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
	const client = new MongoClient(uri, {
		serverSelectionTimeoutMS: 10_000,
		connectTimeoutMS: 10_000,
	});
	await client.connect();
	return { client, db: dbName ? client.db(dbName) : client.db() };
}
