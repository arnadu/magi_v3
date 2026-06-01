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

export async function verifyFirebaseToken(token: string): Promise<{
	uid: string;
	email: string;
	displayName?: string;
}> {
	const decoded = await getAuth().verifyIdToken(token);
	return {
		uid: decoded.uid,
		email: decoded.email ?? "",
		displayName: decoded.name,
	};
}
