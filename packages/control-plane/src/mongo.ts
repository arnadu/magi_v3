import { MongoClient } from "mongodb";

export async function connectMongo(
	uri: string,
): Promise<{ client: MongoClient; db: ReturnType<MongoClient["db"]> }> {
	const client = new MongoClient(uri);
	await client.connect();
	const db = client.db();
	return { client, db };
}
