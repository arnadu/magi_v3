#!/usr/bin/env node

/**
 * magi-tool — CLI client for the Tool API server.
 *
 * Background job scripts call this to invoke LLM-requiring tools via the
 * daemon's Tool API server. The daemon injects MAGI_TOOL_TOKEN and
 * MAGI_TOOL_URL into the script's environment when spawning background jobs.
 *
 * Usage:
 *   magi-tool <tool-name> [options]
 *
 * Options (all tools):
 *   --params '<json>'           JSON object with tool parameters (merged with flag params)
 *
 * Options (research):
 *   --question  <text>          Research question (required)
 *   --context-file <path>       Context file path (repeatable)
 *   --output    <path>          Write finding text to this file
 *   --max-age-hours <n>         Cache freshness threshold (default: 0 when --context-file used)
 *
 * Options (fetch-url):
 *   --url       <url>           URL to fetch
 *   --max-images <n>            Max images to caption (default: 3)
 *
 * Options (post-message):
 *   --to        <agentId>       Recipient agent id
 *   --subject   <text>          Message subject
 *   --body      <text>          Message body
 *
 * Environment:
 *   MAGI_TOOL_URL    Tool API base URL (default: http://localhost:4001)
 *   MAGI_TOOL_TOKEN  Bearer token (required)
 *
 * Output:
 *   On success: JSON response printed to stdout; exit 0.
 *   If --output is set for research: finding text written to file; JSON still to stdout.
 *   On error: error message to stderr; exit 1.
 */

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Minimal HTTP client (stdlib — no npm deps at runtime)
// ---------------------------------------------------------------------------

interface ToolResponse {
	result?: { content: Array<{ type: string; text?: string; [k: string]: unknown }> };
	error?: string;
}

function callTool(
	baseUrl: string,
	token: string,
	toolName: string,
	params: Record<string, unknown>,
): Promise<ToolResponse> {
	return new Promise((resolve, reject) => {
		const body = Buffer.from(JSON.stringify(params), "utf8");
		const url = new URL(`/tools/${encodeURIComponent(toolName)}`, baseUrl);
		const isHttps = url.protocol === "https:";
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const http = createRequire(import.meta.url)(isHttps ? "https" : "http") as typeof import("node:http");

		const req = http.request(
			{
				hostname: url.hostname,
				port: url.port || (isHttps ? 443 : 80),
				path: url.pathname + url.search,
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
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ToolResponse);
					} catch (e) {
						reject(new Error(`Failed to parse response JSON: ${(e as Error).message}`));
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
// Arg parser
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
	toolName: string;
	params: Record<string, unknown>;
	outputPath: string | null;
} {
	const args = argv.slice(2); // drop node + script path

	if (args.length === 0) {
		console.error(
			"Usage: magi-tool <tool-name> [--params '<json>'] [tool-specific flags]\n" +
			"       magi-tool research --question '...' [--context-file file]... [--output path]\n" +
			"       magi-tool fetch-url --url 'https://...'\n" +
			"       magi-tool post-message --to agentId --subject '...' --body '...'",
		);
		process.exit(1);
	}

	const toolName = args[0];
	const params: Record<string, unknown> = {};
	let outputPath: string | null = null;
	const contextFiles: string[] = [];

	// --params '<json>' base object
	const paramsIdx = args.indexOf("--params");
	if (paramsIdx !== -1 && args[paramsIdx + 1]) {
		try {
			Object.assign(params, JSON.parse(args[paramsIdx + 1]));
		} catch {
			console.error("Error: --params must be valid JSON");
			process.exit(1);
		}
	}

	// Named flags — override anything in --params.
	for (let i = 1; i < args.length; i++) {
		const flag = args[i];
		const val = args[i + 1];

		if (flag === "--params") { i++; continue; } // already handled

		if (flag === "--output" && val) {
			outputPath = val; i++; continue;
		}
		if (flag === "--question" && val) {
			params.question = val; i++; continue;
		}
		if (flag === "--max-age-hours" && val) {
			params.max_age_hours = Number(val); i++; continue;
		}
		if (flag === "--context-file" && val) {
			contextFiles.push(val); i++; continue;
		}
		if (flag === "--url" && val) {
			params.url = val; i++; continue;
		}
		if (flag === "--max-images" && val) {
			params.max_images = Number(val); i++; continue;
		}
		if (flag === "--to" && val) {
			params.to = [val]; i++; continue;
		}
		if (flag === "--subject" && val) {
			params.subject = val; i++; continue;
		}
		if (flag === "--body" && val) {
			params.body = val; i++; continue;
		}
		// Unknown flag — silently ignore (forward compatibility).
	}

	if (contextFiles.length > 0) {
		params.context_files = contextFiles;
		// Default to 0 when context files are provided (always fresh).
		if (params.max_age_hours === undefined) {
			params.max_age_hours = 0;
		}
	}

	// Map --output to output_path param for the research tool.
	if (outputPath && (toolName === "research" || toolName === "Research")) {
		params.output_path = outputPath;
		outputPath = null; // tool handles writing; no post-write needed
	}

	return { toolName, params, outputPath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const baseUrl = process.env.MAGI_TOOL_URL ?? "http://localhost:4001";
	const token = process.env.MAGI_TOOL_TOKEN;

	if (!token) {
		console.error("Error: MAGI_TOOL_TOKEN environment variable is required");
		process.exit(1);
	}

	const { toolName, params, outputPath } = parseArgs(process.argv);

	let response: ToolResponse;
	try {
		response = await callTool(baseUrl, token, toolName, params);
	} catch (e) {
		console.error(`Error: failed to call tool API: ${(e as Error).message}`);
		process.exit(1);
	}

	// Print full JSON to stdout regardless of success/error.
	console.log(JSON.stringify(response, null, 2));

	if (response.error) {
		console.error(`Tool error: ${response.error}`);
		process.exit(1);
	}

	// --output path: write the text content of the result to a file.
	if (outputPath && response.result?.content) {
		const text = response.result.content
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string)
			.join("");
		try {
			writeFileSync(outputPath, text, "utf-8");
		} catch (e) {
			console.error(`Error: failed to write output file: ${(e as Error).message}`);
			process.exit(1);
		}
	}
}

main().catch((e: unknown) => {
	console.error(e);
	process.exit(1);
});
