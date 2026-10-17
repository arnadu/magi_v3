import { connectMongo, connectWithRetry } from "../mongo.js";
import type { BootContext } from "./context.js";

export async function connectToMongo(
	ctx: Pick<BootContext, "mongoUri">,
): Promise<Pick<BootContext, "client" | "db">> {
	process.stdout.write("[daemon] Connecting to MongoDB…\n");
	// Retried with backoff: a daemon that exits on one failed connect makes
	// Fly restart the mission machine until its restart cap, then leaves it
	// stopped — the mission looks "suspended" for a DNS blip.
	const { client, db } = await connectWithRetry(
		() => connectMongo(ctx.mongoUri),
		{ log: (line) => console.error(`[daemon] ${line}`) },
	);
	process.stdout.write("[daemon] MongoDB connected.\n");
	return { client, db };
}
