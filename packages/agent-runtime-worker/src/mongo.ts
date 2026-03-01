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
	const client = new MongoClient(uri);
	await client.connect();
	return { client, db: dbName ? client.db(dbName) : client.db() };
}
