/**
 * The cockpit's one way to call the control plane: `request()` maps a 401 to
 * AuthError and a 403 to ForbiddenError with the server's own text; every
 * other failure throws. Domain modules in this folder build on it.
 */

/** 401: no usable session — the app shows the login screen. */
export class AuthError extends Error {}
/** 403: signed in, but this action is refused (cap above the ceiling, disabled route, not the owner). Shown, never treated as signed-out. */
export class ForbiddenError extends Error {}

async function errorText(res: Response, path: string): Promise<string> {
	const body = (await res
		.clone()
		.json()
		.catch(() => null)) as { error?: string } | null;
	return body?.error ?? `HTTP ${res.status} for ${path}`;
}

/**
 * Every cockpit call goes through here so the status mapping exists once:
 * 401 → AuthError, 403 → ForbiddenError with the server's message, any other
 * non-2xx → Error with the server's message. Callers never see a failed
 * response as success.
 */
export async function request(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const res = await fetch(path, {
		credentials: "include",
		...init,
		headers: { Accept: "application/json", ...(init.headers ?? {}) },
	});
	if (res.status === 401) throw new AuthError("not signed in");
	if (res.status === 403) throw new ForbiddenError(await errorText(res, path));
	if (!res.ok) throw new Error(await errorText(res, path));
	return res;
}

export async function api<T>(path: string): Promise<T> {
	return (await (await request(path)).json()) as T;
}

/** Folded objectives tree — reads Mongo directly (ADR-0019), works while suspended. */

/** Path-segment encoding for ids in URLs. */
export const mp = (id: string) => encodeURIComponent(id);
