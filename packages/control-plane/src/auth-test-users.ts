/**
 * The test-only sign-in (security assurance plan, environment B): fixed tokens for test tenants,
 * so a local stack can be scanned and attacked as two signed-in users without Firebase.
 *
 *   AUTH_TEST_USERS="<token>=test-<name>,<token>=test-<name>"
 *
 * Never on Fly: with FLY_APP_NAME set the auth middleware cannot be built, so a control plane
 * given this variable there refuses to start. A test user is an ordinary tenant (never an admin),
 * its id starts with `test-` so it can never be a Firebase uid, and each token is at least 32
 * characters (the runner generates them per run).
 */
import { safeEqual } from "./auth.js";

const MIN_TOKEN_LENGTH = 32;
const TEST_USER_RE = /^test-[a-z0-9-]{1,40}$/;

/** token → test user id; null when the variable is unset or empty. Throws on Fly or a malformed entry. */
export function testUsersFromEnv(
	env: NodeJS.ProcessEnv,
): ReadonlyMap<string, string> | null {
	const raw = env.AUTH_TEST_USERS?.trim();
	if (!raw) return null;
	if (env.FLY_APP_NAME) {
		throw new Error(
			`AUTH_TEST_USERS is set on Fly (FLY_APP_NAME=${env.FLY_APP_NAME}): the test-only sign-in is refused there; remove the variable`,
		);
	}
	const users = new Map<string, string>();
	for (const entry of raw.split(",")) {
		const eq = entry.indexOf("=");
		const token = entry.slice(0, eq).trim();
		const userId = entry.slice(eq + 1).trim();
		if (
			eq < 1 ||
			token.length < MIN_TOKEN_LENGTH ||
			!TEST_USER_RE.test(userId)
		) {
			throw new Error(
				`AUTH_TEST_USERS: each entry must be <token of ${MIN_TOKEN_LENGTH}+ characters>=test-<name>; got an entry for "${userId}"`,
			);
		}
		users.set(token, userId);
	}
	return users;
}

/** The test user a credential names, compared in constant time; undefined when none. */
export function matchTestUser(
	users: ReadonlyMap<string, string>,
	provided: string,
): string | undefined {
	let found: string | undefined;
	for (const [token, userId] of users) {
		if (safeEqual(provided, token)) found = userId;
	}
	return found;
}
