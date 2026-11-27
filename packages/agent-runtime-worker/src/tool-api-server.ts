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
 *   504                                  — tool timed out (its maxRuntimeMs, else 120 s)
 *
 * Container-ready: MAGI_TOOL_URL env var overrides the default loopback
 * address. Scripts and the Python SDK read this env var. In Kubernetes,
 * set MAGI_TOOL_URL to the service DNS name — zero code changes required.
 *
 * Tools exposed:
 *   FetchUrl, InspectImage, Research, SearchWeb, PostMessage, and the
 *   data-fred / data-fmp / data-newsapi provider proxies (CR-04: jobs get a
 *   capability, never the key)
 *   (Bash/WriteFile/EditFile are NOT exposed — scripts call these natively
 *   as the agent's Linux user; they have no need for the API.)
 */

import { randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { EntryTag, TeamConfig } from "@magi/agent-config";
import type { Message, Model } from "@mariozechner/pi-ai";
import { eventCostUsd, type LlmCallMeter } from "./llm-meter.js";
import type { MailboxRepository } from "./mailbox.js";
import { createMailboxTools } from "./mailbox.js";
import { checkToolArguments } from "./tool-args.js";
import {
	tryCreateDataFmpTool,
	tryCreateDataFredTool,
	tryCreateDataNewsapiTool,
} from "./tools/data-provider-proxy.js";
import { createFetchUrlTool } from "./tools/fetch-url.js";
import { createInspectImageTool } from "./tools/inspect-image.js";
import { createInvestigateTool } from "./tools/investigate.js";
import { createResearchTool } from "./tools/research.js";
import { tryCreateSearchWebTool } from "./tools/search-web.js";
import {
	createSecurityAlertsTool,
	type SecurityAlertsClient,
} from "./tools/security-alerts.js";
import type { SubAgentHooks } from "./tools/sub-agent-hooks.js";
import type { AclPolicy, MagiTool } from "./tools.js";
import type { AgentIdentity } from "./workspace-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenContext {
	acl: AclPolicy;
	identity: AgentIdentity;
	/** The job the token was issued to: a sub-agent's stored steps name it. */
	jobId: string;
}

/** Per-call timeout for a tool that declares no runtime of its own (`maxRuntimeMs`). */
const TOOL_TIMEOUT_MS = 120_000;

/** How long one call may run: the tool's own declared runtime (a sub-agent's minutes), else 120 s. */
export function toolTimeoutMs(
	tool: Pick<MagiTool, "maxRuntimeMs">,
	args: Record<string, unknown>,
): number {
	return tool.maxRuntimeMs?.(args) ?? TOOL_TIMEOUT_MS;
}

/**
 * Runs one call, raced against its timeout (not merely signalled: a tool that ignores the
 * AbortSignal used to hold the request open forever and the documented 504 never happened,
 * audit TA2).
 */
async function executeWithTimeout(
	tool: MagiTool,
	callId: string,
	args: Record<string, unknown>,
): Promise<
	| { result: Awaited<ReturnType<MagiTool["execute"]>> }
	| { failure: "timeout" }
	| { failure: "error"; error: string }
> {
	const ac = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(
			() => {
				ac.abort();
				resolve("timeout");
			},
			toolTimeoutMs(tool, args),
		);
	});
	try {
		const outcome = await Promise.race([
			tool.execute(callId, args, ac.signal),
			timeout,
		]);
		if (outcome === "timeout") return { failure: "timeout" };
		return { result: outcome };
	} catch (err) {
		return ac.signal.aborted
			? { failure: "timeout" }
			: { failure: "error", error: String(err) };
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// ToolApiServer
// ---------------------------------------------------------------------------

/**
 * HTTP server that dispatches tool calls from background job scripts.
 * One instance is created per daemon; tokens are issued per job spawn.
 */
/** Charging, gating and recording for the LLM-backed tools jobs may call (CST-1). */
export interface ToolApiSpend {
	/** Meter for LLM calls a job makes as `agentId`: log, charge the agent's lifetime cost, check the cap. */
	meterFor: (agentId: string) => LlmCallMeter;
	/** True while the spend cap has paused the mission. */
	isBudgetPaused: () => boolean;
	/** Stores one step of a job's sub-agent, under its agent, outside any turn. */
	recordStep: (
		agentId: string,
		jobId: string,
		toolUseId: string,
		msg: Message,
	) => Promise<void>;
}

/**
 * A job's sub-agent: every step stored and every call charged to the job's
 * agent; the cap's pause stops it at its next model call (a turn's sub-agent
 * waits instead, but a job's HTTP call cannot hold for hours).
 */
export function jobSubAgentHooks(
	spend: ToolApiSpend,
	agentId: string,
	jobId: string,
	loopModel: Model<string>,
): SubAgentHooks {
	return {
		costOf: (event) => eventCostUsd(event, loopModel),
		onMessage: (toolUseId, msg) =>
			spend.recordStep(agentId, jobId, toolUseId, msg),
		onLlmCall: spend.meterFor(agentId),
		beforeLlmCall: async () => {
			if (spend.isBudgetPaused())
				throw new Error(
					"the mission's spend cap is reached and the mission is paused; the sub-agent stopped",
				);
		},
	};
}

/** A tool a background job may call through the Tool API. */
interface ToolApiEntry {
	/** Accepted names, lower-case; the first is the documented one. */
	names: readonly string[];
	/** The operation the tool serves (ADR-0036). */
	operation: EntryTag;
	/** Its calls reach an LLM, so the spend cap's pause refuses them. */
	callsLlm?: boolean;
	/** A fresh, stateless tool for this token's context; null when not configured. */
	build: (
		ctx: TokenContext,
		meter: () => LlmCallMeter,
		subAgent: () => SubAgentHooks,
	) => MagiTool | null;
}

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
		/** How LLM-backed tools are charged and gated (CST-1). */
		private readonly spend: ToolApiSpend,
		/** Who may read security alerts, and how (security.read-alerts); absent: nobody. */
		private readonly securityAlerts?: {
			agents: readonly string[];
			client: SecurityAlertsClient;
		},
	) {}

	// ---------------------------------------------------------------------------
	// Token management
	// ---------------------------------------------------------------------------

	/**
	 * Issue a fresh bearer token for a background job.
	 * The token inherits the agent's AclPolicy so tool calls cannot exceed the
	 * same privilege boundary the agent has in the interactive loop.
	 */
	issueToken(acl: AclPolicy, identity: AgentIdentity, jobId: string): string {
		const token = randomUUID();
		this.tokens.set(token, { acl, identity, jobId });
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
			res.end(
				JSON.stringify({ error: "unauthorized — invalid or expired token" }),
			);
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

		// The cap's pause stops jobs' LLM spend as it stops the agents'.
		const entry = this.entryFor(toolName);
		if (entry?.callsLlm && this.spend.isBudgetPaused()) {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: `tool ${toolName} refused: the mission's spend cap is reached and the mission is paused; retry after the cap is raised`,
				}),
			);
			return;
		}

		// Build the requested tool for this token's context.
		const tool =
			entry?.build(
				ctx,
				() => this.spend.meterFor(ctx.acl.agentId),
				() =>
					jobSubAgentHooks(this.spend, ctx.acl.agentId, ctx.jobId, this.model),
			) ?? null;
		if (!tool) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `unknown tool: ${toolName}` }));
			return;
		}

		// Background-job scripts send whatever JSON they built; hold them to the
		// same schema the LLM is held to (LP2/MB1) instead of letting a wrong
		// shape throw inside the tool as a 500.
		const callId = randomUUID();
		const checked = checkToolArguments(tool, {
			id: callId,
			name: toolName,
			arguments: params,
		});
		if (!checked.ok) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: checked.message }));
			return;
		}

		const run = await executeWithTimeout(tool, callId, checked.args);
		if ("failure" in run) {
			const timedOut = run.failure === "timeout";
			res.writeHead(timedOut ? 504 : 500, {
				"Content-Type": "application/json",
			});
			res.end(
				JSON.stringify({
					error: timedOut ? `tool ${toolName} timed out` : run.error,
				}),
			);
			return;
		}
		const { result } = run;

		res.writeHead(200, { "Content-Type": "application/json" });
		if (result.isError) {
			const text = result.content.map((c) => c.text).join("");
			res.end(JSON.stringify({ error: text }));
		} else {
			res.end(JSON.stringify({ result: { content: result.content } }));
		}
	}

	// ---------------------------------------------------------------------------
	// The tools jobs may call — each built fresh per request, its LLM calls
	// logged and charged to the job's agent through `meter`
	// ---------------------------------------------------------------------------

	private readonly entries: readonly ToolApiEntry[] = [
		{
			names: ["fetch-url", "fetchurl"],
			operation: "web.fetch",
			callsLlm: true,
			build: (_ctx, meter) =>
				createFetchUrlTool(this.visionModel, this.sharedDir, [], {
					meter: meter(),
				}),
		},
		{
			names: ["inspect-image", "inspectimage"],
			operation: "web.fetch",
			callsLlm: true,
			build: (ctx, meter) =>
				createInspectImageTool(
					ctx.identity.workdir,
					this.visionModel,
					[],
					meter(),
				),
		},
		{
			names: ["research"],
			operation: "web.research",
			callsLlm: true,
			build: (ctx, _meter, subAgent) =>
				createResearchTool(this.model, this.sharedDir, ctx.acl, {
					hooks: subAgent(),
					visionModel: this.visionModel,
				}),
		},
		{
			names: ["investigate"],
			operation: "agent.investigate",
			callsLlm: true,
			build: (ctx, _meter, subAgent) =>
				createInvestigateTool(this.model, ctx.acl, {
					workdir: ctx.identity.workdir,
					hooks: subAgent(),
				}),
		},
		{
			names: ["security-alerts"],
			operation: "security.read-alerts",
			// Only for the agents the mission names; anyone else sees an unknown tool.
			build: (ctx) =>
				this.securityAlerts?.agents.includes(ctx.acl.agentId)
					? createSecurityAlertsTool(
							this.securityAlerts.client,
							ctx.acl.agentId,
						)
					: null,
		},
		{
			names: ["search-web", "searchweb"],
			operation: "web.search",
			build: () => tryCreateSearchWebTool() ?? null,
		},
		{
			names: ["post-message", "postmessage"],
			operation: "message.send",
			// PostMessage is the first tool returned by createMailboxTools; it
			// posts as the agent, like its own PostMessage — not as its OS
			// user, which differs under the legacy linuxUser override (TA3).
			build: (ctx) =>
				createMailboxTools(
					this.mailboxRepo,
					this.teamConfig,
					ctx.acl.agentId,
				)[0],
		},
		// CR-04 (job-env half): internal, not agent-facing — only the
		// data-factory Python adapters call these, instead of holding the real
		// provider key themselves.
		{
			names: ["data-fred"],
			operation: "data.query",
			build: () => tryCreateDataFredTool(),
		},
		{
			names: ["data-fmp"],
			operation: "data.query",
			build: () => tryCreateDataFmpTool(),
		},
		{
			names: ["data-newsapi"],
			operation: "data.query",
			build: () => tryCreateDataNewsapiTool(),
		},
	];

	/** The names a background job may call (POST /tools/<name>), with their operations. */
	toolNames(): ReadonlyArray<{ name: string; operation: string }> {
		return this.entries.flatMap((e) =>
			e.names.map((name) => ({ name, operation: e.operation })),
		);
	}

	private entryFor(name: string): ToolApiEntry | undefined {
		const normalised = name.toLowerCase();
		return this.entries.find((e) => e.names.includes(normalised));
	}
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Largest request body accepted (TA1); tool arguments are small. */
const MAX_BODY_BYTES = 1_000_000;

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				req.destroy();
				reject(new Error(`request body over ${MAX_BODY_BYTES} bytes`));
				return;
			}
			chunks.push(chunk);
		});
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
