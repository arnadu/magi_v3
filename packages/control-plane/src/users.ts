import type { Db } from "mongodb";

export interface UserDoc {
	/** Firebase UID — used as userId throughout the system. */
	uid: string;
	email: string;
	displayName?: string;
	createdAt: Date;
	lastLoginAt: Date;
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
