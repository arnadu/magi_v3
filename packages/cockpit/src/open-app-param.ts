/**
 * The apps host sends an operator back here as `/?openApp=<capability>`
 * (ADR-0037): a copied link, an expired session, a moved machine. The
 * capability is 32 hex characters; anything else is ignored.
 */
export function openAppParam(search: string): string | null {
	const cap = new URLSearchParams(search).get("openApp");
	return cap && /^[0-9a-f]{32}$/.test(cap) ? cap : null;
}

/** The same URL without the parameter, so a reload does not reopen the app. */
export function withoutOpenAppParam(href: string): string {
	const u = new URL(href);
	u.searchParams.delete("openApp");
	return u.toString();
}
