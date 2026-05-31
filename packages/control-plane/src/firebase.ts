import * as admin from "firebase-admin";

let initialized = false;

export function initFirebase(): void {
	if (initialized) return;
	initialized = true;
	const key = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
	const projectId = process.env.FIREBASE_PROJECT_ID;
	if (key) {
		admin.initializeApp({
			credential: admin.credential.cert(
				JSON.parse(key) as admin.ServiceAccount,
			),
		});
	} else if (projectId) {
		// Cloud Run / App Engine — default credentials
		admin.initializeApp({
			credential: admin.credential.applicationDefault(),
			projectId,
		});
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
	const decoded = await admin.auth().verifyIdToken(token);
	return {
		uid: decoded.uid,
		email: decoded.email ?? "",
		displayName: decoded.name,
	};
}
