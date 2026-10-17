/**
 * Browser-side defence in depth for the cockpit (F-049): a Content Security
 * Policy, `nosniff`, a referrer policy and a frame-ancestors restriction on
 * every response the control plane serves.
 *
 * The CSP ships **report-only** until `CSP_ENFORCE=true`: the cockpit loads
 * Firebase Auth (popup + iframe to the auth domain), mermaid (inline styles)
 * and KaTeX (bundled fonts), and agent-authored HTML previews are shown in
 * `sandbox="allow-scripts"` iframes whose `srcdoc` inherits this policy — so
 * the exact source list is verified against real violation reports
 * (`POST /api/csp-report`, logged) before it blocks anything. The policy
 * string is identical in both modes; only the header name changes.
 */

import type { NextFunction, Request, Response } from "express";

export interface CspOptions {
	/** Firebase auth domain (e.g. `magi-dev.firebaseapp.com`) — popup/iframe origin for sign-in. */
	firebaseAuthDomain?: string;
	/** `script-src` additions, e.g. a nonce or an extra origin. */
	extraScriptSrc?: string[];
}

export function buildCsp(opts: CspOptions = {}): string {
	const authOrigin = opts.firebaseAuthDomain
		? `https://${opts.firebaseAuthDomain.replace(/^https?:\/\//, "")}`
		: "";
	const google = [
		"https://*.googleapis.com",
		"https://securetoken.googleapis.com",
		"https://identitytoolkit.googleapis.com",
		"https://www.googleapis.com",
		"https://apis.google.com",
		"https://accounts.google.com",
	];
	const scriptSrc = [
		"'self'",
		"https://apis.google.com",
		...(opts.extraScriptSrc ?? []),
	];
	const directives = [
		"default-src 'self'",
		`script-src ${scriptSrc.join(" ")}`,
		// mermaid and KaTeX set inline styles; no inline *scripts* anywhere.
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob: https://*.googleusercontent.com",
		"font-src 'self' data:",
		`connect-src 'self' ${google.join(" ")}${authOrigin ? ` ${authOrigin}` : ""}`,
		`frame-src 'self' blob: https://accounts.google.com${authOrigin ? ` ${authOrigin}` : ""}`,
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'self'",
		"report-uri /api/csp-report",
	];
	return directives.join("; ");
}

export function cspEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.CSP_ENFORCE === "true";
}

/** Express middleware: sets the headers on every response (API, static, SPA fallback). */
export function securityHeaders(opts: CspOptions & { enforce?: boolean } = {}) {
	const csp = buildCsp(opts);
	const header =
		(opts.enforce ?? cspEnforced())
			? "Content-Security-Policy"
			: "Content-Security-Policy-Report-Only";
	return (_req: Request, res: Response, next: NextFunction): void => {
		res.setHeader(header, csp);
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "same-origin");
		res.setHeader("X-Frame-Options", "SAMEORIGIN");
		res.setHeader(
			"Permissions-Policy",
			"camera=(), microphone=(), geolocation=(), payment=()",
		);
		next();
	};
}

/**
 * Receiver for browser CSP violation reports. Unauthenticated by necessity
 * (the browser posts it); bounded by the caller's rate limit and body cap,
 * and only ever logged — nothing is stored or acted on.
 */
export function cspReportHandler(req: Request, res: Response): void {
	type Report = Record<string, unknown>;
	const body = req.body as
		| { "csp-report"?: Report }
		| Array<{ body?: Report }>
		| undefined;
	const report: Report | undefined = Array.isArray(body)
		? body[0]?.body
		: ((body?.["csp-report"] ?? body) as Report | undefined);
	const pick = (k: string) =>
		typeof report?.[k] === "string"
			? String(report[k]).slice(0, 300)
			: undefined;
	console.warn(
		`[csp] violation { directive: ${JSON.stringify(pick("violated-directive") ?? pick("effectiveDirective"))}, blocked: ${JSON.stringify(pick("blocked-uri") ?? pick("blockedURL"))}, document: ${JSON.stringify(pick("document-uri") ?? pick("documentURL"))}, sample: ${JSON.stringify(pick("script-sample") ?? pick("sample"))} }`,
	);
	res.status(204).end();
}
