import { connectMongo } from "../mongo.js";
import type { BootContext } from "./context.js";

export async function connectToMongo(
	ctx: Pick<BootContext, "mongoUri">,
): Promise<Pick<BootContext, "client" | "db">> {
	process.stdout.write("[daemon] Connecting to MongoDB…\n");
	const { client, db } = await connectMongo(ctx.mongoUri);
	process.stdout.write("[daemon] MongoDB connected.\n");
	return { client, db };
}
