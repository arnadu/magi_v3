import { connectWithRetry } from "@magi/agent-runtime-worker";
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
	//
	// Retried with backoff (connectWithRetry's doc comment has the live
	// incident): the control plane is the always-on plane — the scheduler,
	// resource monitor and copilot waker all live here — so one DNS blip at
	// boot must not leave it stopped at Fly's restart cap.
	return connectWithRetry(
		async () => {
			const client = new MongoClient(uri, {
				serverSelectionTimeoutMS: 10_000,
				ignoreUndefined: true,
			});
			await client.connect();
			return { client, db: client.db() };
		},
		{ log: (line) => console.error(`[control-plane] ${line}`) },
	);
}
