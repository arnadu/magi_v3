/**
 * Tool API Server — HTTP endpoint exposing LLM-requiring tools to background
 * job scripts via bearer token authentication.
 *
 * Background scripts (refresh.py, agent-written scripts) call:
 *   POST http://localhost:4001/tools/<name>
 *   Authorization: Bearer <MAGI_TOOL_TOKEN>
 *   Content-Type: application/json
 *   { ...toolParams }
 *
 * The daemon issues a token when spawning a background job and revokes it
 * when the job exits. Tokens are in-memory only — lost on restart, which is
 * fine because running jobs will fail on their next tool call and exit.
 *
 * Protocol:
 *   200 { result: { content: [...] } }   — tool ran successfully
 *   200 { error: "..." }                 — tool ran but returned isError
 *   401                                  — missing/invalid token
 *   404                                  — unknown tool name
 *   405                                  — method not POST
 *   504                                  — tool timed out (120 s default)
 *
 * Container-ready: MAGI_TOOL_URL env var overrides the default loopback
 * address. Scripts and the Python SDK read this env var. In Kubernetes,
 * set MAGI_TOOL_URL to the service DNS name — zero code changes required.
 *
 * Tools exposed:
 *   FetchUrl, InspectImage, Research, SearchWeb, PostMessage
 *   (Bash/WriteFile/EditFile are NOT exposed — scripts call these natively
 *   as the agent's Linux user; they have no need for the API.)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Model } from "@mariozechner/pi-ai";
import type { TeamConfig } from "@magi/agent-config";
import type { MailboxRepository } from "./mailbox.js";
import { createMailboxTools } from "./mailbox.js";
import { createFetchUrlTool } from "./tools/fetch-url.js";
import { createInspectImageTool } from "./tools/inspect-image.js";
import { createResearchTool } from "./tools/research.js";
import { tryCreateSearchWebTool } from "./tools/search-web.js";
import type { AclPolicy, MagiTool } from "./tools.js";
import type { AgentIdentity } from "./workspace-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenContext {
	acl: AclPolicy;
	identity: AgentIdentity;
}

/** Default per-tool call timeout in milliseconds. */
const TOOL_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// ToolApiServer
// ---------------------------------------------------------------------------

/**
 * HTTP server that dispatches tool calls from background job scripts.
 * One instance is created per daemon; tokens are issued per job spawn.
 */
export class ToolApiServer {
	private readonly tokens = new Map<string, TokenContext>();
	private server: ReturnType<typeof createServer> | null = null;

	constructor(
		/** Primary reasoning model (used by Research sub-loop). */
		private readonly model: Model<string>,
		/** Vision model (used by FetchUrl image captioning, InspectImage). */
		private readonly visionModel: Model<string>,
		/** Mission shared directory — FetchUrl artifacts, Research index written here. */
		private readonly sharedDir: string,
		/** Mailbox repo — needed by PostMessage tool. */
		private readonly mailboxRepo: MailboxRepository,
		/** Team config — needed for PostMessage recipient validation. */
		private readonly teamConfig: TeamConfig,
	) {}

	// ---------------------------------------------------------------------------
	// Token management
	// ---------------------------------------------------------------------------

	/**
	 * Issue a fresh bearer token for a background job.
	 * The token inherits the agent's AclPolicy so tool calls cannot exceed the
	 * same privilege boundary the agent has in the interactive loop.
	 */
	issueToken(acl: AclPolicy, identity: AgentIdentity): string {
		const token = randomUUID();
		this.tokens.set(token, { acl, identity });
		return token;
	}

	/** Revoke a token after the job exits (success, failure, or timeout). */
	revokeToken(token: string): void {
		this.tokens.delete(token);
	}

	// ---------------------------------------------------------------------------
	// HTTP server
	// ---------------------------------------------------------------------------

	listen(port: number): void {
		this.server = createServer((req, res) => {
			this.handleRequest(req, res).catch((err) => {
				console.error("[tool-api] Unhandled error:", err);
				if (!res.headersSent) {
					res.writeHead(500).end(JSON.stringify({ error: "internal error" }));
				}
			});
		});
		this.server.listen(port, "127.0.0.1", () => {
			console.log(`[tool-api] Listening on http://127.0.0.1:${port}`);
		});
	}

	stop(): void {
		this.server?.close();
	}

	// ---------------------------------------------------------------------------
	// Request handling
	// ---------------------------------------------------------------------------

	private async handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		// Only POST is valid.
		if (req.method !== "POST") {
			res.writeHead(405, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "method not allowed" }));
			return;
		}

		// Parse URL: /tools/<name>
		const match = (req.url ?? "").match(/^\/tools\/([^/?]+)/);
		if (!match) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "not found — use /tools/<name>" }));
			return;
		}
		const toolName = decodeURIComponent(match[1]);

		// Authenticate.
		const auth = req.headers.authorization ?? "";
		const tokenMatch = auth.match(/^Bearer (.+)$/);
		const rawToken = tokenMatch?.[1] ?? "";
		const ctx = this.tokens.get(rawToken);
		if (!ctx) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized — invalid or expired token" }));
			return;
		}

		// Read JSON body.
		let params: Record<string, unknown>;
		try {
			params = await readJson(req);
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "invalid JSON body" }));
			return;
		}

		// Build the requested tool for this token's context.
		const tool = this.buildTool(toolName, ctx);
		if (!tool) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `unknown tool: ${toolName}` }));
			return;
		}

		// Execute with timeout.
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), TOOL_TIMEOUT_MS);
		let result: Awaited<ReturnType<MagiTool["execute"]>>;
		try {
			result = await tool.execute(randomUUID(), params, ac.signal);
		} catch (err) {
			clearTimeout(timer);
			if (ac.signal.aborted) {
				res.writeHead(504, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: `tool ${toolName} timed out` }));
			} else {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: String(err) }));
			}
			return;
		}
		clearTimeout(timer);

		res.writeHead(200, { "Content-Type": "application/json" });
		if (result.isError) {
			const text = result.content.map((c) => c.text).join("");
			res.end(JSON.stringify({ error: text }));
		} else {
			res.end(JSON.stringify({ result: { content: result.content } }));
		}
	}

	// ---------------------------------------------------------------------------
	// Tool factory — creates a fresh stateless tool instance per request
	// ---------------------------------------------------------------------------

	private buildTool(name: string, ctx: TokenContext): MagiTool | null {
		const normalised = name.toLowerCase();

		if (normalised === "fetch-url" || normalised === "fetchurl") {
			return createFetchUrlTool(this.visionModel, this.sharedDir);
		}

		if (normalised === "inspect-image" || normalised === "inspectimage") {
			return createInspectImageTool(ctx.identity.workdir, this.visionModel);
		}

		if (normalised === "research") {
			return createResearchTool(this.model, this.sharedDir, ctx.acl);
		}

		if (normalised === "search-web" || normalised === "searchweb") {
			const tool = tryCreateSearchWebTool();
			return tool ?? null;
		}

		if (normalised === "post-message" || normalised === "postmessage") {
			// PostMessage is the first tool returned by createMailboxTools.
			const tools = createMailboxTools(
				this.mailboxRepo,
				this.teamConfig,
				ctx.identity.linuxUser, // background jobs send as the agent's linux user
			);
			return tools[0]; // PostMessage
		}

		return null;
	}
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}
