import { MongoClient } from "mongodb";

export async function connectMongo(
	uri: string,
): Promise<{ client: MongoClient; db: ReturnType<MongoClient["db"]> }> {
	// ignoreUndefined: without this, the driver's default BSON serialization
	// turns any `undefined`-valued field in an insertOne document or a $set
	// update into a literal stored `null` — see
	// agent-runtime-worker/src/mongo.ts's doc comment for the full incident
	// (missionCopilotLimits: undefined silently persisted as null, then
	// failed Zod's `.optional()`, not `.nullable()`, validation on every
	// subsequent read). This is a second, separate MongoClient from that
	// package's connectMongo() — both need the flag, since control-plane's
	// own writes (missions.ts's POST /, etc.) go through this one.
	const client = new MongoClient(uri, { ignoreUndefined: true });
	await client.connect();
	const db = client.db();
	return { client, db };
}
