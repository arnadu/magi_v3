import { createHash } from "node:crypto";
import {
	applicationDefault,
	cert,
	initializeApp,
	type ServiceAccount,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

let initialized = false;

export function initFirebase(): void {
	if (initialized) return;
	initialized = true;
	const key = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
	const projectId = process.env.FIREBASE_PROJECT_ID;
	if (key) {
		initializeApp({ credential: cert(JSON.parse(key) as ServiceAccount) });
	} else if (projectId) {
		// Cloud Run / App Engine — default credentials
		initializeApp({ credential: applicationDefault(), projectId });
	} else {
		throw new Error(
			"FIREBASE_SERVICE_ACCOUNT_KEY or FIREBASE_PROJECT_ID is required",
		);
	}
}

/**
 * AUTH2 (#7): a revoked session (sign-out everywhere, disabled user)
 * kept working until the ID token expired, because `verifyIdToken` only
 * checks the signature. Checking revocation is a round trip to Firebase, so
 * it is done at most once per token per REVOCATION_RECHECK_MS; the cached
 * verdict applies to the same token string only.
 */
export const REVOCATION_RECHECK_MS = 5 * 60_000;
const revocationChecked = new Map<string, number>();

export function needsRevocationCheck(
	tokenKey: string,
	now: number = Date.now(),
	checked: Map<string, number> = revocationChecked,
): boolean {
	const last = checked.get(tokenKey);
	if (last !== undefined && now - last < REVOCATION_RECHECK_MS) return false;
	if (checked.size > 5_000) checked.clear();
	checked.set(tokenKey, now);
	return true;
}

export async function verifyFirebaseToken(token: string): Promise<{
	uid: string;
	email: string;
	displayName?: string;
}> {
	const key = createHash("sha256").update(token).digest("hex");
	const decoded = await getAuth().verifyIdToken(
		token,
		needsRevocationCheck(key),
	);
	return {
		uid: decoded.uid,
		email: decoded.email ?? "",
		displayName: decoded.name,
	};
}
