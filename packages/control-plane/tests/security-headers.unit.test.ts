import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildCsp,
	cspEnforced,
	cspReportHandler,
	securityHeaders,
} from "../src/security-headers.js";

function fakeRes() {
	const headers = new Map<string, string>();
	let statusCode = 200;
	let ended = false;
	return {
		headers,
		get status() {
			return statusCode;
		},
		get ended() {
			return ended;
		},
		res: {
			setHeader: (k: string, v: string) => {
				headers.set(k, v);
			},
			status: (c: number) => {
				statusCode = c;
				return {
					end: () => {
						ended = true;
					},
				};
			},
		},
	};
}

describe("buildCsp", () => {
	it("locks down the defaults and never allows inline script", () => {
		const csp = buildCsp();
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain("base-uri 'self'");
		expect(csp).toContain("frame-ancestors 'self'");
		expect(csp).toContain("report-uri /api/csp-report");
		const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
		expect(scriptSrc).toBeDefined();
		expect(scriptSrc).not.toContain("unsafe-inline");
		expect(scriptSrc).not.toContain("unsafe-eval");
	});

	it("admits the Firebase auth domain for frames and XHR, scheme stripped", () => {
		const csp = buildCsp({ firebaseAuthDomain: "https://x.firebaseapp.com" });
		const frame = csp.split("; ").find((d) => d.startsWith("frame-src"));
		const connect = csp.split("; ").find((d) => d.startsWith("connect-src"));
		expect(frame).toContain("https://x.firebaseapp.com");
		expect(connect).toContain("https://x.firebaseapp.com");
		expect(csp).not.toContain("https://https://");
	});
});

describe("securityHeaders middleware", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("reports only by default and sets the companion headers", () => {
		const r = fakeRes();
		let nextCalled = false;
		securityHeaders({ enforce: false })({} as never, r.res as never, () => {
			nextCalled = true;
		});
		expect(nextCalled).toBe(true);
		expect(r.headers.has("Content-Security-Policy-Report-Only")).toBe(true);
		expect(r.headers.has("Content-Security-Policy")).toBe(false);
		expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(r.headers.get("Referrer-Policy")).toBe("same-origin");
		expect(r.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
	});

	it("enforces when asked, with the identical policy string", () => {
		const r = fakeRes();
		securityHeaders({ enforce: true })({} as never, r.res as never, () => {});
		expect(r.headers.get("Content-Security-Policy")).toBe(buildCsp());
		expect(r.headers.has("Content-Security-Policy-Report-Only")).toBe(false);
	});

	it("reads CSP_ENFORCE=true from the environment, anything else means report-only", () => {
		expect(cspEnforced({ CSP_ENFORCE: "true" })).toBe(true);
		expect(cspEnforced({ CSP_ENFORCE: "1" })).toBe(false);
		expect(cspEnforced({})).toBe(false);
	});
});

describe("cspReportHandler", () => {
	it("logs a bounded summary of either report format and answers 204", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const legacy = fakeRes();
		cspReportHandler(
			{
				body: {
					"csp-report": {
						"violated-directive": "script-src",
						"blocked-uri": "inline",
						"document-uri": "https://x/",
						"script-sample": "x".repeat(1000),
					},
				},
			} as never,
			legacy.res as never,
		);
		expect(legacy.status).toBe(204);
		expect(legacy.ended).toBe(true);
		expect(warn.mock.calls[0][0]).toContain('directive: "script-src"');
		expect((warn.mock.calls[0][0] as string).length).toBeLessThan(600);

		const modern = fakeRes();
		cspReportHandler(
			{
				body: [
					{
						body: {
							effectiveDirective: "img-src",
							blockedURL: "https://evil/",
						},
					},
				],
			} as never,
			modern.res as never,
		);
		expect(modern.status).toBe(204);
		expect(warn.mock.calls[1][0]).toContain('directive: "img-src"');
		expect(warn.mock.calls[1][0]).toContain('blocked: "https://evil/"');

		const empty = fakeRes();
		cspReportHandler({ body: undefined } as never, empty.res as never);
		expect(empty.status).toBe(204);
		warn.mockRestore();
	});
});
