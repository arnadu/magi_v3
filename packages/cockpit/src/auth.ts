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
 * Ports the legacy dashboard's auth mechanism (index.html) to the cockpit —
 * same magi_session cookie, same admin-key sessionStorage key, same
 * onIdTokenChanged-drives-the-cookie pattern — but via the modular `firebase`
 * npm package instead of the compat CDN scripts index.html loaded. Those CDN
 * scripts (gstatic.com, no SRI) are finding F-018; retiring index.html only
 * closes that finding if the cockpit doesn't reintroduce the same pattern.
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

const ADMIN_KEY_SESSION = "magi_admin_key";
// Firebase's own auth-state listener only fires for Firebase-driven changes
// (popup sign-in, sign-out, token refresh) — the admin-key path is plain
// sessionStorage with no such listener, so subscribeAuth also listens for
// this to react to it.
const ADMIN_KEY_EVENT = "magi-admin-key-changed";

export type AuthState =
	| { status: "loading" }
	| { status: "signed-out"; error: string | null }
	| { status: "signed-in"; email: string };

function setSessionCookie(token: string): void {
	// SameSite=Strict prevents cross-site requests from carrying the cookie.
	// No Secure flag needed — the server enforces HTTPS at the load balancer.
	// biome-ignore lint/suspicious/noDocumentCookie: intentional cross-tab session cookie, matches the legacy dashboard's mechanism
	document.cookie = `magi_session=${encodeURIComponent(token)}; path=/; SameSite=Strict; max-age=3600`;
}

function clearSessionCookie(): void {
	// biome-ignore lint/suspicious/noDocumentCookie: intentional cross-tab session cookie
	document.cookie = "magi_session=; path=/; SameSite=Strict; max-age=0";
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

/** Subscribes to auth state; returns an unsubscribe function. Fires once immediately with the current state. */
export function subscribeAuth(
	onChange: (state: AuthState) => void,
): () => void {
	const auth = getFirebaseAuth();

	const recheckAdminKey = () => {
		if (auth?.currentUser) return; // Firebase already covers this case
		const key = sessionStorage.getItem(ADMIN_KEY_SESSION);
		onChange(
			key
				? { status: "signed-in", email: "admin" }
				: { status: "signed-out", error: null },
		);
	};
	window.addEventListener(ADMIN_KEY_EVENT, recheckAdminKey);

	if (!auth) {
		recheckAdminKey();
		return () => window.removeEventListener(ADMIN_KEY_EVENT, recheckAdminKey);
	}

	// Fires on sign-in, sign-out, AND every hourly token refresh, so
	// magi_session is always a valid, non-expired token.
	const unsubscribe = onIdTokenChanged(auth, async (user) => {
		if (user) {
			setSessionCookie(await user.getIdToken());
			onChange({ status: "signed-in", email: user.email ?? "" });
		} else if (sessionStorage.getItem(ADMIN_KEY_SESSION)) {
			onChange({ status: "signed-in", email: "admin" });
		} else {
			clearSessionCookie();
			onChange({ status: "signed-out", error: null });
		}
	});
	return () => {
		unsubscribe();
		window.removeEventListener(ADMIN_KEY_EVENT, recheckAdminKey);
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
	// Validate by probing /api/missions — server returns 401 if wrong, 200 if correct.
	const res = await fetch("/api/missions", {
		headers: { Authorization: `Bearer ${trimmed}` },
	});
	if (res.status === 401) return "Invalid key.";
	sessionStorage.setItem(ADMIN_KEY_SESSION, trimmed);
	setSessionCookie(trimmed);
	window.dispatchEvent(new Event(ADMIN_KEY_EVENT));
	return null;
}

export async function signOut(): Promise<void> {
	sessionStorage.removeItem(ADMIN_KEY_SESSION);
	clearSessionCookie();
	window.dispatchEvent(new Event(ADMIN_KEY_EVENT));
	const auth = getFirebaseAuth();
	if (auth) await firebaseSignOut(auth).catch(() => {});
}
