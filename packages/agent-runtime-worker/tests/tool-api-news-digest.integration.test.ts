/**
 * Sprint 12 — Integration Test: Tool API Server + Research with news digest
 *
 * Scenario:
 *   A background job (simulated here without sudo) wants to generate a news
 *   brief from a digest.json file. It calls:
 *
 *     POST http://localhost:<port>/tools/research
 *     { question: "...", context_files: [digest.json], output_path: brief.md, max_age_hours: 0 }
 *
 *   The Tool API server:
 *     1. Validates the bearer token
 *     2. Reads the digest.json context file
 *     3. Runs the Research sub-loop (FetchUrl-only, no SearchWeb — context-only mode)
 *     4. Writes the finding to brief.md
 *     5. Returns { result: { content: [...] } }
 *
 * Assertions:
 *   1. HTTP 200 with a { result } body (no error field)
 *   2. brief.md created and non-empty (> 200 chars)
 *   3. brief.md contains a "Sources" section
 *   4. brief.md mentions NVDA or NVIDIA
 *
 * Requires: ANTHROPIC_API_KEY in .env.
 * Does NOT require: MONGODB_URI, daemon, pool users.
 * Network: fetches one article URL from the test digest.
 *
 * Timeout: 3 minutes (Research sub-loop fetches URLs).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLAUDE_HAIKU, CLAUDE_SONNET } from "../src/models.js";
import { ToolApiServer } from "../src/tool-api-server.js";
import type { AclPolicy } from "../src/tools.js";
import type { AgentIdentity } from "../src/workspace-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** POST to the Tool API server and return the parsed JSON response. */
function callToolApi(
	port: number,
	token: string,
	toolName: string,
	params: Record<string, unknown>,
): Promise<{ result?: { content: Array<{ type: string; text?: string }> }; error?: string }> {
	return new Promise((resolve, reject) => {
		const body = Buffer.from(JSON.stringify(params), "utf8");
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port,
				path: `/tools/${encodeURIComponent(toolName)}`,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": body.length,
					Authorization: `Bearer ${token}`,
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					} catch (e) {
						reject(e);
					}
				});
			},
		);
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Tool API: research with news digest (Sprint 12)", () => {
	let server: ToolApiServer;
	let port: number;
	let token: string;
	let tmpDir: string;
	let sharedDir: string;
	let digestPath: string;
	let briefPath: string;

	beforeAll(async () => {
		// Find a free port.
		port = await new Promise<number>((res) => {
			const srv = http.createServer();
			srv.listen(0, "127.0.0.1", () => {
				const addr = srv.address() as { port: number };
				srv.close(() => res(addr.port));
			});
		});

		tmpDir = mkdtempSync(join(tmpdir(), "magi-tool-api-test-"));
		sharedDir = join(tmpDir, "shared");

		// Create a minimal but realistic NVDA news digest.
		// Uses a real publicly-accessible news URL so FetchUrl can actually fetch it.
		// The Research sub-loop will call FetchUrl on the URL in context-only mode.
		digestPath = join(tmpDir, "digest.json");
		briefPath = join(tmpDir, "brief.md");

		const digest = {
			generated_at: new Date().toISOString(),
			items: [
				{
					title: "NVIDIA Reports Record Revenue on AI Chip Demand",
					url: "https://en.wikipedia.org/wiki/Nvidia",
					source: "Wikipedia",
					published_at: new Date().toISOString(),
					summary: "NVIDIA Corporation designs and sells GPUs and AI accelerators.",
					is_new: true,
				},
			],
		};
		writeFileSync(digestPath, JSON.stringify(digest, null, 2), "utf-8");

		// Build model instances.
		const model = CLAUDE_SONNET;
		const visionModel = CLAUDE_HAIKU;

		// Create a minimal MailboxRepository stub (PostMessage not needed for this test).
		const mailboxRepoStub = {
			async post() { return { id: "stub", missionId: "test", from: "test", to: [], subject: "", body: "", createdAt: new Date() }; },
			async listUnread() { return []; },
			async listHeaders() { return []; },
			async read() { return null; },
		};

		// Minimal TeamConfig stub.
		const teamConfigStub = {
			mission: { id: "test-mission", name: "Test" },
			agents: [{ id: "test-agent", supervisor: "user", systemPrompt: "", initialMentalMap: "", linuxUser: "nobody" }],
		};

		server = new ToolApiServer(
			model,
			visionModel,
			sharedDir,
			mailboxRepoStub as never,
			teamConfigStub as never,
		);
		server.listen(port);

		// Issue a token for a test agent identity.
		const acl: AclPolicy = {
			agentId: "test-agent",
			linuxUser: "nobody",
			permittedPaths: [tmpDir, sharedDir],
		};
		const identity: AgentIdentity = {
			workdir: tmpDir,
			sharedDir,
			linuxUser: "nobody",
		};
		token = server.issueToken(acl, identity);
	}, 10_000);

	afterAll(() => {
		server.stop();
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
	});

	it("returns 401 for invalid token", async () => {
		const result = await callToolApi(port, "bad-token", "research", { question: "test" });
		expect(result).toHaveProperty("error");
		expect((result.error ?? "").toLowerCase()).toContain("unauthorized");
	});

	it("returns 404 for unknown tool", async () => {
		const result = await callToolApi(port, token, "nonexistent-tool", {});
		expect(result).toHaveProperty("error");
		expect((result.error ?? "").toLowerCase()).toContain("unknown tool");
	});

	it(
		"synthesises a news brief from digest.json",
		async () => {
			const result = await callToolApi(port, token, "research", {
				question:
					"Summarise the latest NVDA news from today's digest. " +
					"Fetch the article URLs provided. Write 3–5 bullet points. " +
					"End with a Sources section listing the URLs you read.",
				context_files: [digestPath],
				output_path: briefPath,
				max_age_hours: 0,
			});

			// 1. Response has no error and has result content.
			expect(result).not.toHaveProperty("error");
			expect(result.result?.content).toBeDefined();
			expect(result.result!.content.length).toBeGreaterThan(0);

			const text = result.result!.content
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("");

			// 2. Response is substantive.
			expect(text.length).toBeGreaterThan(200);

			// 3. brief.md was written.
			const brief = readFileSync(briefPath, "utf-8");
			expect(brief.length).toBeGreaterThan(200);

			// 4. brief mentions NVDA or NVIDIA.
			expect(brief.toLowerCase()).toMatch(/nvidia|nvda|gpu/i);

			// 5. brief has a Sources section.
			expect(brief.toLowerCase()).toContain("source");
		},
		3 * 60 * 1_000, // 3 min
	);
});
