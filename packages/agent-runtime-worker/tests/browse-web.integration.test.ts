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

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function startTestServer(): Promise<{
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
	let tmpDir: string;
	let handle: BrowseWebHandle | undefined;

	beforeAll(async () => {
		const srv = await startTestServer();
		baseUrl = srv.baseUrl;
		server = srv.server;

		tmpDir = mkdtempSync(join(tmpdir(), "magi-browse-"));
		chmodSync(tmpDir, 0o755);
		// Grant pool user access (required by setfacl-protected workdirs in integration tests)
		spawnSync("setfacl", ["-m", "u:magi-w1:rwx", tmpDir]);

		// Allow 127.0.0.1 so the test can reach its own local HTTP server.
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
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

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
});
