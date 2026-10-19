import { type FirebaseApp, initializeApp } from "firebase/app";
import {
	type Auth,
	signOut as firebaseSignOut,
	GoogleAuthProvider,
	getAuth,
	onIdTokenChanged,
	signInWithPopup,
} from "firebase/auth";

/**
 * Browser-side sign-in. The credential — a Firebase ID token or the admin
 * API key — is presented once, as a bearer token, to `POST /api/auth/session`;
 * the server answers with an `HttpOnly; Secure; SameSite=Strict` cookie, and
 * every later request (fetch with `credentials: "include"`, EventSource with
 * `withCredentials`) carries that. Nothing credential-bearing is kept where
 * page script can read it: before this, the cookie was written from JS and
 * the admin key sat in `sessionStorage`, so an XSS in rendered agent output
 * (TB-8/TB-18/TB-20) could have walked off with CONTROL_API_KEY itself. A
 * reload therefore asks the server whether a session exists
 * (`GET /api/auth/me`) instead of consulting local storage.
 */

declare global {
	interface Window {
		FIREBASE_CONFIG?: {
			apiKey?: string;
			authDomain?: string;
			projectId?: string;
		};
	}
}

// Firebase's own listener only fires for Firebase-driven changes (popup
// sign-in, sign-out, token refresh); the admin-key path has no such listener,
// so subscribeAuth also listens for this.
const SESSION_EVENT = "magi-session-changed";

export type AuthState =
	| { status: "loading" }
	| { status: "signed-out"; error: string | null }
	| { status: "signed-in"; email: string };

type IssueResult = "ok" | "invalid" | { error: string };

async function issueSession(credential: string): Promise<IssueResult> {
	try {
		const res = await fetch("/api/auth/session", {
			method: "POST",
			credentials: "include",
			headers: { Authorization: `Bearer ${credential}` },
		});
		if (res.ok) return "ok";
		if (res.status === 401) return "invalid";
		return { error: `Sign-in failed (HTTP ${res.status}).` };
	} catch (e) {
		return { error: (e as Error).message || "Sign-in failed." };
	}
}

async function currentSession(): Promise<{
	userId: string;
	isAdmin: boolean;
} | null> {
	try {
		const res = await fetch("/api/auth/me", { credentials: "include" });
		if (!res.ok) return null;
		return (await res.json()) as { userId: string; isAdmin: boolean };
	} catch {
		return null;
	}
}

async function endSession(): Promise<void> {
	await fetch("/api/auth/logout", {
		method: "POST",
		credentials: "include",
	}).catch((e: unknown) =>
		// The cookie then lives until it expires (1 h); the UI still signs out.
		console.warn("Sign-out request failed:", (e as Error).message),
	);
}

let firebaseAuth: Auth | null | undefined;

/** Only initializes Firebase when a real API key is configured — avoids background auth/invalid-api-key errors otherwise. */
function getFirebaseAuth(): Auth | null {
	if (firebaseAuth !== undefined) return firebaseAuth;
	if (!window.FIREBASE_CONFIG?.apiKey) {
		firebaseAuth = null;
		return null;
	}
	const app: FirebaseApp = initializeApp(window.FIREBASE_CONFIG);
	firebaseAuth = getAuth(app);
	return firebaseAuth;
}

/** Subscribes to auth state; returns an unsubscribe function. Fires once with the current state. */
export function subscribeAuth(
	onChange: (state: AuthState) => void,
): () => void {
	const auth = getFirebaseAuth();
	let firebaseSignedIn = false;

	// The cookie session is the source of truth for the admin-key path: ask
	// the server rather than any client-side storage.
	const recheckSession = async () => {
		if (firebaseSignedIn) return;
		const me = await currentSession();
		onChange(
			me
				? { status: "signed-in", email: me.isAdmin ? "admin" : me.userId }
				: { status: "signed-out", error: null },
		);
	};
	const onSessionEvent = () => void recheckSession();
	window.addEventListener(SESSION_EVENT, onSessionEvent);

	if (!auth) {
		void recheckSession();
		return () => window.removeEventListener(SESSION_EVENT, onSessionEvent);
	}

	// Fires on sign-in, sign-out, AND every hourly token refresh, so the
	// server-issued cookie is always re-issued from a valid, unexpired token.
	const unsubscribe = onIdTokenChanged(auth, async (user) => {
		if (user) {
			firebaseSignedIn = true;
			const result = await issueSession(await user.getIdToken());
			if (result === "ok") {
				onChange({ status: "signed-in", email: user.email ?? "" });
			} else {
				onChange({
					status: "signed-out",
					error:
						result === "invalid"
							? "This Google account is not authorised."
							: result.error,
				});
			}
		} else {
			firebaseSignedIn = false;
			await recheckSession();
		}
	});
	return () => {
		unsubscribe();
		window.removeEventListener(SESSION_EVENT, onSessionEvent);
	};
}

/** Returns an error message on failure, null on success. */
export async function signInWithGoogle(): Promise<string | null> {
	const auth = getFirebaseAuth();
	if (!auth) return "Firebase not configured. Use admin key below.";
	try {
		await signInWithPopup(auth, new GoogleAuthProvider());
		return null;
	} catch (e) {
		return (e as Error).message || "Sign in failed.";
	}
}

/** Returns an error message on failure, null on success. */
export async function signInWithApiKey(key: string): Promise<string | null> {
	const trimmed = key.trim();
	if (!trimmed) return "Enter an API key.";
	const result = await issueSession(trimmed);
	if (result === "invalid") return "Invalid key.";
	if (result !== "ok") return result.error;
	window.dispatchEvent(new Event(SESSION_EVENT));
	return null;
}

export async function signOut(): Promise<void> {
	await endSession();
	window.dispatchEvent(new Event(SESSION_EVENT));
	const auth = getFirebaseAuth();
	if (auth) {
		await firebaseSignOut(auth).catch((e: unknown) =>
			console.warn("Firebase sign-out failed:", (e as Error).message),
		);
	}
}
