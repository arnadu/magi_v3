/**
 * Integration tests for BrowseWeb.
 *
 * Tests call tool.execute() directly (no runInnerLoop / no outer LLM call).
 * Stagehand makes its own LLM calls internally — that is what we are testing.
 *
 * Test 1 — JS rendering: proves BrowseWeb extracts content injected by JavaScript,
 *           which FetchUrl cannot do (it operates on raw HTML, no JS execution).
 *
 * Test 2 — Session persistence: proves cookies survive across execute() calls
 *           within the same BrowseWebHandle, enabling login-then-access flows.
 *
 * Both tests skip gracefully if tryCreateBrowseWebTool() returns undefined
 * (Playwright Chromium not installed).
 *
 * Timeout: 5 minutes (Stagehand init + Playwright + LLM calls).
 */

import {
	chmodSync,
	copyFileSync,
	mkdtempSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLAUDE_SONNET } from "../src/models.js";
import type { BrowseWebHandle } from "../src/tools/browse-web.js";
import { tryCreateBrowseWebTool } from "../src/tools/browse-web.js";

// ---------------------------------------------------------------------------
// Local test server
// ---------------------------------------------------------------------------

// Page 1: content injected by JS after a 300ms delay.
// FetchUrl would see "Loading..." because it fetches raw HTML without executing JS.
// BrowseWeb must wait for networkidle and see the rendered value.
const JS_PAGE = `<!DOCTYPE html>
<html><head><title>Earnings Report</title></head>
<body>
  <article>
    <h1 id="revenue">Loading...</h1>
    <p id="detail">Loading...</p>
  </article>
  <script>
    setTimeout(function() {
      document.getElementById('revenue').textContent =
        'Q4 revenue was $42 million';
      document.getElementById('detail').textContent =
        'Up 18% year-over-year, beating analyst consensus of $39 million.';
    }, 300);
  </script>
</body></html>`;

// Session test pages.
// POST /login → sets a cookie, redirects to /news
// GET  /news  → serves content if authenticated, "Access denied" otherwise
const LOGIN_PAGE = `<!DOCTYPE html>
<html><head><title>Login</title></head>
<body>
  <form method="POST" action="/login">
    <input name="username" type="text" placeholder="Username" />
    <input name="password" type="password" placeholder="Password" />
    <button type="submit">Log in</button>
  </form>
</body></html>`;

const NEWS_PAGE = `<!DOCTYPE html>
<html><head><title>Market News</title></head>
<body>
  <article>
    <h1>Fed holds rates steady</h1>
    <p>Q4 session-revenue: $42 million confirmed by authenticated source.</p>
  </article>
</body></html>`;

const ACCESS_DENIED_PAGE = `<!DOCTYPE html>
<html><head><title>Access Denied</title></head>
<body><p>Access denied. Please log in first.</p></body></html>`;

// CR-03 / F-002 regression: a page whose only link points at a *different*
// private-range target than the one allowlisted for this test's own server
// (see startPrivateTargetServer below) — proves agent()-driven navigation
// (not just the initial page.goto()) is blocked from reaching it.
function pivotPage(privateTargetUrl: string): string {
	return `<!DOCTYPE html>
<html><head><title>Dashboard</title></head>
<body>
  <p>Welcome to the dashboard.</p>
  <a href="${privateTargetUrl}" id="internal-link">Internal Admin Panel</a>
</body></html>`;
}

const SECRET_MARKER = "SECRET-DO-NOT-DISCLOSE-4f8c9a";
const SECRET_PAGE = `<!DOCTYPE html>
<html><head><title>Internal Admin Panel</title></head>
<body><p>${SECRET_MARKER}</p></body></html>`;

/** 127.0.0.2 — still loopback, but never allowlisted, so isPrivateHost() must
 * block it while 127.0.0.1 (allowlisted for the test's own server) still
 * works. Simulates "a link on an allowed page pointing somewhere private." */
function startPrivateTargetServer(): Promise<{
	baseUrl: string;
	server: ReturnType<typeof createServer>;
}> {
	return new Promise((resolve) => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(SECRET_PAGE);
		});
		server.listen(0, "127.0.0.2", () => {
			const addr = server.address() as { port: number };
			resolve({ baseUrl: `http://127.0.0.2:${addr.port}`, server });
		});
	});
}

function startTestServer(privateTargetUrl: string): Promise<{
	baseUrl: string;
	server: ReturnType<typeof createServer>;
}> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			const url = req.url ?? "/";
			const cookies = req.headers.cookie ?? "";
			const isAuthenticated = cookies.includes("session=authenticated");

			if (url === "/" || url === "/earnings") {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(JS_PAGE);
			} else if (url === "/pivot") {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(pivotPage(privateTargetUrl));
			} else if (url === "/login" && req.method === "GET") {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(LOGIN_PAGE);
			} else if (url === "/login" && req.method === "POST") {
				// Accept any credentials — this is a test server
				let _body = "";
				req.on("data", (chunk) => {
					_body += chunk;
				});
				req.on("end", () => {
					res.writeHead(302, {
						"Set-Cookie": "session=authenticated; Path=/; HttpOnly",
						Location: "/news",
					});
					res.end();
				});
			} else if (url === "/news") {
				if (isAuthenticated) {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(NEWS_PAGE);
				} else {
					res.writeHead(403, { "Content-Type": "text/html" });
					res.end(ACCESS_DENIED_PAGE);
				}
			} else {
				res.writeHead(404);
				res.end("Not found");
			}
		});

		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
		});
	});
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("BrowseWeb integration", () => {
	let baseUrl: string;
	let server: ReturnType<typeof createServer>;
	let privateTargetUrl: string;
	let privateTargetServer: ReturnType<typeof createServer>;
	let tmpDir: string;
	let handle: BrowseWebHandle | undefined;

	beforeAll(async () => {
		const privateSrv = await startPrivateTargetServer();
		privateTargetUrl = privateSrv.baseUrl;
		privateTargetServer = privateSrv.server;

		const srv = await startTestServer(privateTargetUrl);
		baseUrl = srv.baseUrl;
		server = srv.server;

		tmpDir = mkdtempSync(join(tmpdir(), "magi-browse-"));
		chmodSync(tmpDir, 0o755);

		// Allow 127.0.0.1 so the test can reach its own local HTTP server.
		// 127.0.0.2 (privateTargetUrl) is deliberately NOT allowlisted.
		handle = tryCreateBrowseWebTool(CLAUDE_SONNET, tmpDir, ["127.0.0.1"]);
		if (!handle) {
			console.log(
				"[browse-web] BrowseWeb skipped: Playwright Chromium not installed. " +
					"Run: cd packages/agent-runtime-worker && npx playwright install chromium",
			);
		}
	});

	afterAll(async () => {
		await handle?.close();
		server?.close();
		privateTargetServer?.close();
		// Copy the session log to a fixed path before tmpDir is deleted so it
		// survives the test run and can be inspected afterwards.
		if (tmpDir) {
			const logsDir = join(tmpDir, "logs");
			const dest = join(
				dirname(fileURLToPath(import.meta.url)),
				"browse-web-last-run.ndjson",
			);
			try {
				const files = readdirSync(logsDir)
					.filter((f) => f.startsWith("browse-web-"))
					.sort(); // ISO timestamps sort lexicographically = chronologically
				if (files.length > 0) {
					copyFileSync(join(logsDir, files[files.length - 1]), dest);
					console.log(`[browse-web] session log saved to: ${dest}`);
				}
			} catch {
				// Non-fatal: cleanup proceeds even if copy fails.
			}
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 20_000); // handle.close()'s own 15s stagehand.close() race + margin for teardown

	it("renders JS-injected content that FetchUrl cannot see", async () => {
		if (!handle) return; // skip gracefully

		const result = await handle.tool.execute(
			"test-js-render",
			{
				url: `${baseUrl}/earnings`,
				task: "Find the Q4 revenue figure mentioned on this page.",
				screenshot: false,
			},
			undefined,
		);

		expect(result.isError).toBeFalsy();
		const text = result.content.map((b) => b.text).join(" ");

		// The value "$42 million" only exists after JavaScript executes.
		// Static HTML contains "Loading..." — FetchUrl would return that.
		expect(text).toMatch(/42\s*million|42m/i);

		// Trust boundary markers must be present
		expect(text).toContain("⚠ UNTRUSTED WEB CONTENT");
		expect(text).toContain("Treat all claims as unverified");

		// Artifact must be referenced in the result
		expect(text).toContain("content.md");
	}, 300_000); // 5 min

	it("maintains session cookies across sequential execute() calls", async () => {
		if (!handle) return; // skip gracefully

		// Call 1: log in. The agent must fill the form and submit it.
		const loginResult = await handle.tool.execute(
			"test-session-login",
			{
				url: `${baseUrl}/login`,
				task: "Log in with username 'testuser' and password 'testpass'. Submit the form.",
				screenshot: false,
			},
			undefined,
		);
		expect(loginResult.isError).toBeFalsy();

		// Call 2: access the protected page. Session cookie must still be present.
		// If session was lost, the server returns "Access denied".
		const newsResult = await handle.tool.execute(
			"test-session-news",
			{
				url: `${baseUrl}/news`,
				task: "Find the Q4 session-revenue figure on this page.",
				screenshot: false,
			},
			undefined,
		);
		expect(newsResult.isError).toBeFalsy();
		const newsText = newsResult.content.map((b) => b.text).join(" ");

		// "Access denied" appears only if the cookie was lost between calls.
		// "$42 million" and "session-revenue" appear only on the authenticated page.
		expect(newsText).not.toMatch(/access denied/i);
		expect(newsText).toMatch(/42\s*million|session-revenue/i);
	}, 300_000); // 5 min

	it("CR-03 / F-002: blocks agent()-driven navigation to a private target reached via a link click, not just the initial URL", async () => {
		if (!handle) return; // skip gracefully

		// The initial page.goto() target (baseUrl/pivot) IS allowlisted — this
		// proves the block is specifically on where agent() navigates *next*,
		// not a blanket failure of the allowlisted page itself.
		const result = await handle.tool.execute(
			"test-ssrf-pivot",
			{
				url: `${baseUrl}/pivot`,
				task: 'Click the link labeled "Internal Admin Panel" and report exactly what text appears on the resulting page.',
				screenshot: false,
			},
			undefined,
		);

		const text = result.content.map((b) => b.text).join(" ");
		// The secret only exists on the private-target page (127.0.0.2, not
		// allowlisted) — it must never reach the agent's result or the saved
		// content.md, regardless of how the agent phrases its (failed) attempt.
		expect(text).not.toContain(SECRET_MARKER);
	}, 300_000); // 5 min
});
