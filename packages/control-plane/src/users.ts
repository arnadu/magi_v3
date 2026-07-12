import type { Db } from "mongodb";

export interface UserDoc {
	/** Firebase UID — used as userId throughout the system. */
	uid: string;
	email: string;
	displayName?: string;
	createdAt: Date;
	lastLoginAt: Date;
	/**
	 * User's preferred model for their copilot's LLM calls. Falls back to the
	 * `MODEL` env var (see copilot-router.ts) when unset — same "Anthropic or
	 * OpenRouter model ID" convention as team-config `model`/`visionModel`.
	 */
	copilotModel?: string;
}

/**
 * Upsert a Firebase user into the local users collection.
 * Called on every authenticated request so lastLoginAt stays current.
 */
export async function syncFirebaseUser(
	db: Db,
	uid: string,
	email: string,
	displayName?: string,
): Promise<void> {
	const now = new Date();
	await db.collection<UserDoc>("users").updateOne(
		{ uid },
		{
			$set: { email, displayName, lastLoginAt: now },
			$setOnInsert: { uid, createdAt: now },
		},
		{ upsert: true },
	);
}

/** Read a user's preferred copilot model, if they've set one. */
export async function getCopilotModel(
	db: Db,
	uid: string,
): Promise<string | undefined> {
	const doc = await db
		.collection<UserDoc>("users")
		.findOne({ uid }, { projection: { copilotModel: 1 } });
	return doc?.copilotModel;
}

/**
 * Set (or clear, with undefined) a user's preferred copilot model. Upserts —
 * the admin (CONTROL_API_KEY) identity never runs through syncFirebaseUser,
 * so it has no users doc to update otherwise; real Firebase users already
 * have one by the time this runs (requireAuth syncs on every request), so
 * the upsert is a no-op update for them in practice.
 */
export async function setCopilotModel(
	db: Db,
	uid: string,
	model: string | undefined,
): Promise<void> {
	await db
		.collection<UserDoc>("users")
		.updateOne(
			{ uid },
			model
				? { $set: { copilotModel: model } }
				: { $unset: { copilotModel: "" } },
			{ upsert: true },
		);
}
