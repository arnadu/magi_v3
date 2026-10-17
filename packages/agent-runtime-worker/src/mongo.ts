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

export interface ConnectRetryOptions {
	/** Give up after this long (default 10 min) and rethrow the last error. */
	maxWaitMs?: number;
	/** First retry delay (default 2 s); doubles up to maxDelayMs (default 30 s). */
	initialDelayMs?: number;
	maxDelayMs?: number;
	log?: (line: string) => void;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

/**
 * Retry a connect function with exponential backoff instead of letting one
 * failed attempt end the process.
 *
 * Why: a process that exits on its first failed connect turns a transient
 * fault into an outage. Seen live (2026-10-17, control plane v390 deploy):
 * one `querySrv ENOTFOUND` for the Atlas SRV record at boot → exit 1 → Fly
 * restarted the machine ten times in a minute, hit its restart cap and left
 * the always-on control plane stopped (scheduler, resource monitor, copilot
 * waker all down) until the next HTTP request happened to auto-start it, five
 * minutes later. The driver's own `serverSelectionTimeoutMS` does not cover
 * this: a DNS failure is thrown immediately, not waited out.
 *
 * Bounded on purpose: a permanently wrong URI must still fail loudly rather
 * than spin forever. Ten minutes comfortably outlasts a DNS blip or an Atlas
 * election and is far shorter than any human would wait for a deploy.
 */
export async function connectWithRetry<T>(
	connect: () => Promise<T>,
	opts: ConnectRetryOptions = {},
): Promise<T> {
	const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;
	const maxDelayMs = opts.maxDelayMs ?? 30_000;
	const log = opts.log ?? ((line) => console.error(line));
	const sleep =
		opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = opts.now ?? Date.now;
	const started = now();
	let delay = opts.initialDelayMs ?? 2_000;
	for (let attempt = 1; ; attempt++) {
		try {
			return await connect();
		} catch (e) {
			const elapsed = now() - started;
			if (elapsed + delay > maxWaitMs) {
				log(
					`[mongo] connect failed on attempt ${attempt} after ${Math.round(elapsed / 1000)} s of retries: ${(e as Error).message} — giving up`,
				);
				throw e;
			}
			log(
				`[mongo] connect failed (attempt ${attempt}): ${(e as Error).message} — retrying in ${Math.round(delay / 1000)} s`,
			);
			await sleep(delay);
			delay = Math.min(delay * 2, maxDelayMs);
		}
	}
}
